const SCHEMA_OBJECT_RENAMES = Object.freeze({
  users: 'user_accounts',
  orgs: 'organization_records',
  memberships: 'organization_memberships',
  projects: 'project_records',
  invites: 'invitation_records',
  webhooks: 'webhook_endpoints',
  baselines: 'project_baselines',
  comments: 'project_comments',
  sprints: 'project_sprints',
  attachments: 'project_attachments',
});

/** Legacy single-word tables that will be replaced by issue #433. */
export const LEGACY_SCHEMA_OBJECTS = Object.freeze(Object.keys(SCHEMA_OBJECT_RENAMES));

/** Canonical two-or-more-word tables required after issue #433 migration. */
export const CANONICAL_SCHEMA_OBJECTS = Object.freeze(Object.values(SCHEMA_OBJECT_RENAMES));

/**
 * Error raised when the process observes an incomplete or mixed schema cutover.
 *
 * A mixed database must not be served because application queries could then
 * read one naming generation while writes target another. Operators should
 * restore or finish the migration before restarting ScopeWeave.
 */
export class SchemaMigrationStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaMigrationStateError';
  }
}

/**
 * Classify the database as the complete legacy or complete canonical schema.
 *
 * Unrelated compliant tables are intentionally ignored. Any mixture, missing
 * expected table, or duplicate old/new naming generation fails closed.
 *
 * @param {Set<string>} objectNames - Current SQLite table names.
 * @returns {'legacy_ready'|'canonical_ready'} Complete schema generation.
 * @throws {TypeError} When `objectNames` is not a Set.
 * @throws {SchemaMigrationStateError} When the migration state is partial or mixed.
 */
export function classifySchemaMigrationState(objectNames) {
  if (!(objectNames instanceof Set)) throw new TypeError('objectNames must be a Set');

  const legacyCount = LEGACY_SCHEMA_OBJECTS.filter((name) => objectNames.has(name)).length;
  const canonicalCount = CANONICAL_SCHEMA_OBJECTS.filter((name) => objectNames.has(name)).length;

  if (legacyCount === LEGACY_SCHEMA_OBJECTS.length && canonicalCount === 0) {
    return 'legacy_ready';
  }
  if (canonicalCount === CANONICAL_SCHEMA_OBJECTS.length && legacyCount === 0) {
    return 'canonical_ready';
  }

  throw new SchemaMigrationStateError(
    `partial or mixed schema migration state: legacy=${legacyCount}/${LEGACY_SCHEMA_OBJECTS.length}, canonical=${canonicalCount}/${CANONICAL_SCHEMA_OBJECTS.length}`,
  );
}

/**
 * Read application table names from SQLite's schema catalog.
 *
 * SQLite internal tables are excluded because they are not ScopeWeave-owned
 * schema objects and cannot participate in the naming migration.
 *
 * @param {{prepare: Function}} database - node:sqlite-compatible database.
 * @returns {Set<string>} Current application table names.
 */
function readApplicationTableNames(database) {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all();
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * Ensure an append-only schema ledger exists and record the complete generation.
 *
 * This is the first expand/verify slice of issue #433. It does not rename data
 * tables. Instead it gives every database an explicit migration ledger and makes
 * startup fail closed if a later rename crashes or otherwise leaves old and new
 * object generations mixed. Repeated startup is idempotent.
 *
 * @param {{exec: Function, prepare: Function}} database - node:sqlite-compatible database.
 * @returns {'legacy_ready'|'canonical_ready'} Verified schema generation.
 * @throws {TypeError} When the database adapter is missing required operations.
 * @throws {SchemaMigrationStateError} When schema or ledger state is inconsistent.
 */
export function ensureSchemaMigrationState(database) {
  if (!database || typeof database.exec !== 'function' || typeof database.prepare !== 'function') {
    throw new TypeError('database must provide exec and prepare');
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_key TEXT PRIMARY KEY,
      state_code TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const state = classifySchemaMigrationState(readApplicationTableNames(database));
  const migrationKey = state === 'legacy_ready' ? 'legacy_schema_v1' : 'canonical_schema_v2';
  database.prepare(
    'INSERT OR IGNORE INTO schema_migrations(migration_key, state_code) VALUES (?, ?)',
  ).run(migrationKey, state);

  const ledgerRow = database.prepare(
    'SELECT state_code AS stateCode FROM schema_migrations WHERE migration_key = ?',
  ).get(migrationKey);
  if (!ledgerRow || ledgerRow.stateCode !== state) {
    throw new SchemaMigrationStateError('schema migration ledger state does not match verified schema');
  }

  return state;
}
