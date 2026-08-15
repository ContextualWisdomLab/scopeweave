const MAX_IDENTIFIER_LENGTH = 128;
const IDENTIFIER_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MIN_WORK_DEPTH = 1;
const MAX_WORK_DEPTH = 4;

/**
 * Maximum number of work items accepted in one project hierarchy payload.
 *
 * The bound is intentionally aligned with ScopeWeave's current commercial
 * acceptance target: a 10,000-item plan must remain supported, while a single
 * request cannot force unbounded graph allocation or traversal.
 */
export const MAX_WORK_ITEMS = 10_000;

/**
 * Stable validation failure returned by the framework-independent hierarchy domain.
 */
export class WorkHierarchyError extends Error {
  /**
   * @param {string} code - Stable machine-readable failure code.
   * @param {number} [status=400] - HTTP-compatible status for thin adapters.
   */
  constructor(code, status = 400) {
    super(code);
    this.name = 'WorkHierarchyError';
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim()
    && !IDENTIFIER_CONTROL_PATTERN.test(value);
}

function parentIdentifier(record) {
  if (record.parentId === null || record.parentId === undefined || record.parentId === '') {
    return null;
  }
  if (!isIdentifier(record.parentId)) {
    throw new WorkHierarchyError('work_hierarchy_parent_id_invalid');
  }
  return record.parentId;
}

function assertAcyclic(itemsById) {
  const state = new Map();

  for (const startId of itemsById.keys()) {
    if (state.get(startId) === 2) continue;

    const path = [];
    let currentId = startId;
    while (currentId && itemsById.has(currentId)) {
      const currentState = state.get(currentId) || 0;
      if (currentState === 1) {
        throw new WorkHierarchyError('work_hierarchy_cycle');
      }
      if (currentState === 2) break;

      state.set(currentId, 1);
      path.push(currentId);
      currentId = parentIdentifier(itemsById.get(currentId));
    }

    for (const id of path) state.set(id, 2);
  }
}

/**
 * Validate one canonical ScopeWeave work-item graph without mutating caller data.
 *
 * The contract accepts existing three-level plans and the new
 * Phase -> Activity -> Task -> Duty depth four. Root parent values may be null,
 * undefined, or the legacy empty string. Every non-root item must reference a
 * present parent exactly one depth above it. Validation is O(n) and bounded to
 * `MAX_WORK_ITEMS`, so adapters can call it synchronously before persistence.
 *
 * @param {unknown} tasks - Candidate project task array.
 * @returns {{itemCount: number, maxDepth: number}} Validated graph summary.
 * @throws {WorkHierarchyError} When the payload violates graph invariants.
 */
export function validateWorkHierarchy(tasks) {
  if (!Array.isArray(tasks)) {
    throw new WorkHierarchyError('work_hierarchy_tasks_invalid');
  }
  if (tasks.length > MAX_WORK_ITEMS) {
    throw new WorkHierarchyError('work_hierarchy_too_large', 413);
  }

  const itemsById = new Map();
  let maxDepth = 0;

  for (const record of tasks) {
    if (!isRecord(record)) {
      throw new WorkHierarchyError('work_hierarchy_record_invalid');
    }
    if (!isIdentifier(record.id)) {
      throw new WorkHierarchyError('work_hierarchy_id_invalid');
    }
    if (itemsById.has(record.id)) {
      throw new WorkHierarchyError('work_hierarchy_id_duplicate');
    }
    if (!Number.isInteger(record.depth)
      || record.depth < MIN_WORK_DEPTH
      || record.depth > MAX_WORK_DEPTH) {
      throw new WorkHierarchyError('work_hierarchy_depth_invalid');
    }
    parentIdentifier(record);
    itemsById.set(record.id, record);
    maxDepth = Math.max(maxDepth, record.depth);
  }

  assertAcyclic(itemsById);

  for (const record of tasks) {
    const parentId = parentIdentifier(record);
    if (record.depth === MIN_WORK_DEPTH) {
      if (parentId !== null) {
        throw new WorkHierarchyError('work_hierarchy_root_parent_invalid');
      }
      continue;
    }

    if (parentId === null) {
      throw new WorkHierarchyError('work_hierarchy_parent_required');
    }
    const parent = itemsById.get(parentId);
    if (!parent) {
      throw new WorkHierarchyError('work_hierarchy_parent_missing');
    }
    if (parent.depth !== record.depth - 1) {
      throw new WorkHierarchyError('work_hierarchy_parent_depth_invalid');
    }
  }

  return { itemCount: tasks.length, maxDepth };
}
