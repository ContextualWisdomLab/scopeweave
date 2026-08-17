const RESOURCE_VERSION_PREFIX = 'project_version:';
const CANONICAL_POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const MAX_WORK_ITEM_ID_LENGTH = 256;
const NOT_ADVANCED = Object.freeze({ advanced: false });

/**
 * Format one authoritative ScopeWeave project version for reason-event ports.
 *
 * The token is deliberately typed rather than exposing a bare database integer,
 * so a project-level concurrency value cannot be confused with another resource
 * version family.
 *
 * @param {unknown} projectVersion positive safe integer stored by `projects.version`.
 * @returns {string} canonical `project_version:<integer>` token.
 * @throws {TypeError} when the version cannot be represented without ambiguity.
 */
export function formatScheduleReasonResourceVersion(projectVersion) {
  if (!Number.isSafeInteger(projectVersion) || projectVersion < 1) {
    throw new TypeError('project version must be a positive safe integer');
  }
  return `${RESOURCE_VERSION_PREFIX}${projectVersion}`;
}

/** Parse an external database identity without accepting lossy numeric syntax. */
function parseCanonicalPositiveInteger(value, field) {
  if (typeof value !== 'string' || !CANONICAL_POSITIVE_INTEGER.test(value)) {
    throw new TypeError(`${field} must be a canonical positive integer string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new TypeError(`${field} must be a canonical positive safe integer string`);
  }
  return parsed;
}

/** Parse one project resource-version token back to its database integer. */
function parseResourceVersion(value) {
  if (typeof value !== 'string' || !value.startsWith(RESOURCE_VERSION_PREFIX)) {
    throw new TypeError('expectedResourceVersion must be a canonical project-version token');
  }
  const versionText = value.slice(RESOURCE_VERSION_PREFIX.length);
  return parseCanonicalPositiveInteger(versionText, 'expectedResourceVersion');
}

/** Require an exact bounded work-item identifier without control characters. */
function requireWorkItemId(value) {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > MAX_WORK_ITEM_ID_LENGTH
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new TypeError('workItemId must be bounded non-blank text without control characters');
  }
  return value;
}

/** Parse the authoritative project task snapshot and count an exact work-item ID. */
function countWorkItemIdentity(tasksJson, workItemId) {
  let tasks;
  try {
    tasks = JSON.parse(tasksJson);
  } catch {
    throw new Error('project tasks_json is invalid');
  }
  if (!Array.isArray(tasks)) {
    throw new Error('project tasks_json is invalid');
  }
  let count = 0;
  for (const task of tasks) {
    if (task && typeof task === 'object' && !Array.isArray(task) && task.id === workItemId) {
      count += 1;
      if (count > 1) {
        throw new Error('project tasks_json contains duplicate work-item identity');
      }
    }
  }
  return count;
}

/**
 * Create the authoritative SQLite project-version transition adapter used by
 * `createSqliteScheduleReasonEventRepository`.
 *
 * ScopeWeave currently stores a project plan atomically in `projects.tasks_json`
 * and protects that plan with `projects.version`. The adapter therefore verifies
 * the exact tenant, project, work-item membership, and expected project version,
 * then advances only `projects.version` with one conditional UPDATE on the same
 * synchronous SQLite connection. It never rewrites task JSON or creates a second
 * work-item/version table. When called inside the reason-event repository
 * savepoint, the version transition rolls back together with event/audit writes.
 *
 * @param {object} database Node SQLite-compatible handle exposing `prepare()`.
 * @returns {Readonly<{advanceResourceVersion: Function}>} immutable transition port.
 */
export function createSqliteScheduleReasonProjectVersionAdapter(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('schedule reason project-version adapter requires database.prepare()');
  }

  const selectProject = database.prepare(`
    SELECT tasks_json, version
      FROM projects
     WHERE id = ? AND org_id = ?
  `);
  const advanceProject = database.prepare(`
    UPDATE projects
       SET version = version + 1,
           updated_at = datetime('now')
     WHERE id = ?
       AND org_id = ?
       AND version = ?
  `);

  return Object.freeze({
    /**
     * Advance the exact project-plan version only while the authorized target
     * work item still exists exactly once in that version's task snapshot.
     *
     * @param {unknown} binding exact tenant/project/work-item/version binding.
     * @returns {Readonly<{advanced: boolean, resourceVersion?: string}>} transition result.
     */
    advanceResourceVersion(binding) {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
        throw new TypeError('project-version transition binding must be an object');
      }
      const organizationId = parseCanonicalPositiveInteger(binding.organizationId, 'organizationId');
      const projectId = parseCanonicalPositiveInteger(binding.projectId, 'projectId');
      const workItemId = requireWorkItemId(binding.workItemId);
      const expectedVersion = parseResourceVersion(binding.expectedResourceVersion);

      const row = selectProject.get(projectId, organizationId);
      if (!row) return NOT_ADVANCED;
      if (!Number.isSafeInteger(row.version) || row.version < 1) {
        throw new Error('stored project version is invalid');
      }
      if (row.version !== expectedVersion) return NOT_ADVANCED;
      if (countWorkItemIdentity(row.tasks_json, workItemId) === 0) return NOT_ADVANCED;
      if (expectedVersion === Number.MAX_SAFE_INTEGER) {
        throw new Error('project version cannot advance beyond the safe integer range');
      }

      const update = advanceProject.run(projectId, organizationId, expectedVersion);
      if (Number(update.changes) !== 1) return NOT_ADVANCED;

      return Object.freeze({
        advanced: true,
        resourceVersion: formatScheduleReasonResourceVersion(expectedVersion + 1),
      });
    },
  });
}
