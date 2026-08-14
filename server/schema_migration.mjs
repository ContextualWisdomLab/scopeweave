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

const MIGRATION_LEDGER_STATES = Object.freeze({
  legacy_schema_v1: 'legacy_ready',
  canonical_schema_v2: 'canonical_ready',
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
 * Validate persisted migration history against the currently verified schema.
 *
 * Known migration keys have one exact state code. A legacy schema may contain
 * only legacy history: observing a canonical migration record while legacy
 * tables are active proves a rollback or interrupted restore and must fail
 * closed. Canonical schemas may retain the earlier legacy record because the
 * ledger is append-only across a forward migration.
 *
 * @param {Array<{migrationKey: unknown, stateCode: unknown}>} rows - Persisted ledger rows.
 * @param {'legacy_ready'|'canonical_ready'} state - Fresh schema classification.
 * @returns {void}
 * @throws {SchemaMigrationStateError} When ledger history is corrupt or moves backward.
 */
function validateMigrationLedgerHistory(rows, state) {
  for (const row of rows) {
    const migrationKey = String(row.migrationKey);
    const stateCode = String(row.stateCode);
    if (MIGRATION_LEDGER_STATES[migrationKey] !== stateCode) {
      throw new SchemaMigrationStateError('schema migration ledger state does not match verified schema');
    }
    if (state === 'legacy_ready' && migrationKey === 'canonical_schema_v2') {
      throw new SchemaMigrationStateError('schema migration ledger history conflicts with verified schema');
    }
  }
}

/**
 * Inspect schema generation before legacy bootstrap DDL is allowed to mutate it.
 *
 * A genuinely empty database is the only state allowed to initialize the legacy
 * schema from scratch. Existing databases must already be one complete known
 * generation; incomplete, mixed, ledger-only, or otherwise ambiguous databases
 * fail closed before `CREATE TABLE IF NOT EXISTS users ...` can recreate legacy
 * names over a canonical cutover.
 *
 * @param {{prepare: Function}} database - node:sqlite-compatible database.
 * @returns {'uninitialized'|'legacy_ready'|'canonical_ready'} Pre-bootstrap state.
 * @throws {TypeError} When the database adapter cannot query the catalog.
 * @throws {SchemaMigrationStateError} When an existing database is incomplete or mixed.
 */
export function inspectSchemaBootstrapState(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('database must provide prepare');
  }

  const objectNames = readApplicationTableNames(database);
  if (objectNames.size === 0) return 'uninitialized';
  return classifySchemaMigrationState(objectNames);
}

/**
 * Ensure an append-only schema ledger exists and record the complete generation.
 *
 * This is the first expand/verify slice of issue #433. It does not rename data
 * tables. Instead it gives every database an explicit migration ledger and makes
 * startup fail closed if a later rename crashes or otherwise leaves old and new
 * object generations mixed. Repeated startup is idempotent, and a database that
 * has ever recorded the canonical generation cannot silently return to legacy
 * tables while retaining canonical migration history.
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
  const existingRows = database.prepare(
    'SELECT migration_key AS migrationKey, state_code AS stateCode FROM schema_migrations ORDER BY migration_key',
  ).all();
  validateMigrationLedgerHistory(existingRows, state);

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
