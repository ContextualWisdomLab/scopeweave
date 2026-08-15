const UNSAFE_IDENTIFIER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Canonical ScopeWeave hierarchy labels indexed by persisted depth minus one.
 * The array is frozen so adapters cannot silently redefine the shared domain.
 */
export const WORK_ITEM_LEVELS = Object.freeze(['phase', 'activity', 'task', 'duty']);

/**
 * Validate persisted work-item relationships for ScopeWeave's four-level plan.
 *
 * Validation is order-independent and intentionally does not repair customer
 * data. A record must have an opaque non-empty string ID, a depth from 1 to 4,
 * and either no parent at depth 1 or an existing parent exactly one level
 * above it. Duplicate IDs, cycles, malformed records, and unsafe object-key
 * identifiers are reported explicitly so storage/API adapters can fail closed.
 *
 * @param {unknown} records persisted work-item records to validate
 * @returns {{valid: boolean, errors: Array<Record<string, unknown>>}} stable validation result
 */
export function validateWorkItemHierarchy(records) {
  if (!Array.isArray(records)) {
    return { valid: false, errors: [{ code: 'invalid_records' }] };
  }

  const errors = [];
  const recordById = new Map();

  for (let sourceIndex = 0; sourceIndex < records.length; sourceIndex += 1) {
    const record = records[sourceIndex];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push({ code: 'invalid_record', sourceIndex });
      continue;
    }

    const { id } = record;
    if (!isValidIdentifier(id)) {
      errors.push({ code: 'invalid_id', sourceIndex });
      continue;
    }

    if (recordById.has(id)) {
      errors.push({ code: 'duplicate_id', id });
      continue;
    }

    recordById.set(id, record);
  }

  for (const [id, record] of recordById) {
    const { depth } = record;
    if (!Number.isInteger(depth) || depth < 1 || depth > WORK_ITEM_LEVELS.length) {
      errors.push({ code: 'invalid_depth', id, depth });
      continue;
    }

    const parentId = normalizeParentId(record.parentId);
    if (depth === 1) {
      if (parentId !== null) {
        errors.push({ code: 'invalid_parent_depth', id, parentId, depth, parentDepth: null });
      }
      continue;
    }

    if (!isValidIdentifier(parentId) || !recordById.has(parentId)) {
      errors.push({ code: 'missing_parent', id, parentId });
      continue;
    }

    const parentDepth = recordById.get(parentId)?.depth;
    if (!Number.isInteger(parentDepth) || parentDepth !== depth - 1) {
      errors.push({ code: 'invalid_parent_depth', id, parentId, depth, parentDepth });
    }
  }

  const cycleIds = findCycleIds(recordById);
  for (const id of cycleIds) {
    errors.push({ code: 'cycle', id });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create immutable, source-position-preserving projection wrappers for a valid plan.
 *
 * Existing three-level plans stay three-level. Every persisted field remains in
 * the nested `record`, including customer fields named `kind` or `sourceIndex`.
 * Canonical hierarchy metadata is stored only on the wrapper, so projection
 * cannot silently overwrite persisted values. A fourth-level Duty is represented
 * only when a source record already exists; this function never synthesizes work.
 *
 * @param {unknown} records persisted ScopeWeave work-item records
 * @returns {Array<Readonly<{record: Readonly<Record<string, unknown>>, kind: string, sourceIndex: number}>>} canonical projected records
 * @throws {Error} when the hierarchy is malformed
 */
export function projectWorkItemHierarchy(records) {
  const validation = validateWorkItemHierarchy(records);
  if (!validation.valid) {
    const codes = validation.errors.map((error) => error.code).join(',');
    throw new Error(`Invalid work-item hierarchy: ${codes}`);
  }

  return records.map((record, sourceIndex) => {
    const projectedRecord = Object.freeze({
      ...record,
      parentId: normalizeParentId(record.parentId),
    });
    return Object.freeze({
      record: projectedRecord,
      kind: WORK_ITEM_LEVELS[record.depth - 1],
      sourceIndex,
    });
  });
}

/** @param {unknown} id candidate opaque identifier @returns {id is string} */
function isValidIdentifier(id) {
  return typeof id === 'string'
    && id.trim().length > 0
    && !UNSAFE_IDENTIFIER_KEYS.has(id);
}

/** @param {unknown} parentId persisted parent value @returns {unknown} canonical parent value */
function normalizeParentId(parentId) {
  return parentId === undefined || parentId === null || parentId === '' ? null : parentId;
}

/**
 * Find every record that participates in a parent-reference cycle.
 * Invalid/missing parents terminate traversal and are handled by relationship
 * validation, so cycle detection remains bounded to O(N) map traversal.
 *
 * @param {Map<string, Record<string, unknown>>} recordById validated ID map
 * @returns {string[]} cycle participant IDs in deterministic insertion order
 */
function findCycleIds(recordById) {
  const stateById = new Map();
  const cycleSet = new Set();

  for (const startId of recordById.keys()) {
    if (stateById.get(startId) === 2) {
      continue;
    }

    const path = [];
    const pathIndex = new Map();
    let currentId = startId;

    while (recordById.has(currentId) && stateById.get(currentId) !== 2) {
      if (pathIndex.has(currentId)) {
        const cycleStart = pathIndex.get(currentId);
        for (let index = cycleStart; index < path.length; index += 1) {
          cycleSet.add(path[index]);
        }
        break;
      }

      pathIndex.set(currentId, path.length);
      path.push(currentId);
      stateById.set(currentId, 1);

      const parentId = normalizeParentId(recordById.get(currentId)?.parentId);
      if (!isValidIdentifier(parentId) || !recordById.has(parentId)) {
        break;
      }
      currentId = parentId;
    }

    for (const id of path) {
      stateById.set(id, 2);
    }
  }

  return [...recordById.keys()].filter((id) => cycleSet.has(id));
}
