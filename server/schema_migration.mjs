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

const MIGRATION_LEDGER_STATES = Object.freeze(Object.assign(Object.create(null), {
  legacy_schema_v1: 'legacy_ready',
  canonical_schema_v2: 'canonical_ready',
}));

const MIGRATION_LEDGER_COLUMNS = Object.freeze([
  Object.freeze({ name: 'migration_key', type: 'TEXT', notNull: 1, primaryKey: 1, defaultValue: '' }),
  Object.freeze({ name: 'state_code', type: 'TEXT', notNull: 1, primaryKey: 0, defaultValue: '' }),
  Object.freeze({
    name: 'applied_at',
    type: 'TEXT',
    notNull: 1,
    primaryKey: 0,
    defaultValue: "datetime('now')",
  }),
]);

const LEGACY_COMPATIBILITY_COLUMNS = Object.freeze([
  Object.freeze({
    tableName: 'users',
    columnName: 'token_version',
    definition: 'token_version INTEGER NOT NULL DEFAULT 0',
    expectedType: 'INTEGER',
    expectedDefaultValue: '0',
  }),
  Object.freeze({
    tableName: 'projects',
    columnName: 'archived',
    definition: 'archived INTEGER NOT NULL DEFAULT 0',
    expectedType: 'INTEGER',
    expectedDefaultValue: '0',
  }),
  Object.freeze({
    tableName: 'projects',
    columnName: 'methodology',
    definition: "methodology TEXT NOT NULL DEFAULT 'waterfall'",
    expectedType: 'TEXT',
    expectedDefaultValue: "'waterfall'",
  }),
]);

/** Legacy single-word tables that will be replaced by issue #433. */
export const LEGACY_SCHEMA_OBJECTS = Object.freeze(Object.keys(SCHEMA_OBJECT_RENAMES));

/** Canonical two-or-more-word tables required after issue #433 migration. */
export const CANONICAL_SCHEMA_OBJECTS = Object.freeze(Object.values(SCHEMA_OBJECT_RENAMES));

const KNOWN_SCHEMA_OBJECTS = new Set([
  ...LEGACY_SCHEMA_OBJECTS,
  ...CANONICAL_SCHEMA_OBJECTS,
]);
const UNRELATED_SCHEMA_OBJECT_SENTINEL = '__scopeweave_unrelated_schema_object__';

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
 * Execute the legacy schema bootstrap as one recoverable SQLite transaction.
 *
 * A first startup that is interrupted after only some CREATE statements must
 * not leave a partial generation that later startup correctly refuses to serve.
 * SQLite rolls back an open transaction after process loss; synchronous DDL
 * failures are rolled back here before the original failure is rethrown. Once
 * a complete schema generation already exists, the helper returns after a
 * read-only catalog verification so rolling startup does not take a write lock
 * merely to re-run idempotent CREATE statements.
 *
 * @param {{exec: Function, prepare?: Function}} database - node:sqlite-compatible database.
 * @param {string} bootstrapSql - Complete legacy CREATE TABLE/INDEX statements.
 * @returns {void}
 * @throws {TypeError} When the adapter or SQL input is unusable.
 */
export function runAtomicLegacySchemaBootstrap(database, bootstrapSql) {
  if (!database || typeof database.exec !== 'function') {
    throw new TypeError('database must provide exec');
  }
  if (typeof bootstrapSql !== 'string' || bootstrapSql.trim() === '') {
    throw new TypeError('bootstrapSql must be a non-empty string');
  }

  if (typeof database.prepare === 'function') {
    const objectNames = readApplicationTableNames(database);
    if (objectNames.size !== 0) {
      classifySchemaMigrationState(objectNames);
      return;
    }
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(bootstrapSql);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the causal bootstrap failure; startup remains fail-closed.
    }
    throw error;
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
 * Read application table names from SQLite's schema catalog with bounded memory.
 *
 * SQLite internal tables are excluded because they are not ScopeWeave-owned
 * schema objects and cannot participate in the naming migration. Known legacy
 * and canonical names are retained exactly; every unrelated application table
 * collapses to one sentinel so a non-empty unknown database cannot be mistaken
 * for a pristine bootstrap while an arbitrarily large catalog cannot force an
 * equally large in-memory result set.
 *
 * @param {{prepare: Function}} database - node:sqlite-compatible database.
 * @returns {Set<string>} Bounded current application table-name evidence.
 */
function readApplicationTableNames(database) {
  const statement = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const objectNames = new Set();
  let sawUnrelatedObject = false;
  for (const row of statement.iterate()) {
    const name = String(row.name);
    if (KNOWN_SCHEMA_OBJECTS.has(name)) objectNames.add(name);
    else sawUnrelatedObject = true;
  }
  if (sawUnrelatedObject) objectNames.add(UNRELATED_SCHEMA_OBJECT_SENTINEL);
  return objectNames;
}

function validateMigrationLedgerSchema(database) {
  const observedColumns = new Map();
  for (const row of database.prepare('PRAGMA table_info(schema_migrations)').iterate()) {
    observedColumns.set(String(row.name), row);
  }

  if (observedColumns.size !== MIGRATION_LEDGER_COLUMNS.length) {
    throw new SchemaMigrationStateError('schema migration ledger schema does not match required contract');
  }

  for (const expected of MIGRATION_LEDGER_COLUMNS) {
    const observed = observedColumns.get(expected.name);
    if (!observed
      || String(observed.type ?? '').trim().toUpperCase() !== expected.type
      || Number(observed.notnull) !== expected.notNull
      || Number(observed.pk) !== expected.primaryKey
      || String(observed.dflt_value ?? '') !== expected.defaultValue) {
      throw new SchemaMigrationStateError('schema migration ledger schema does not match required contract');
    }
  }
}

function matchesCompatibilityColumnContract(row, migration) {
  return String(row.type ?? '').trim().toUpperCase() === migration.expectedType
    && Number(row.notnull) === 1
    && String(row.dflt_value ?? '') === migration.expectedDefaultValue;
}

/**
 * Add historical compatibility columns only when catalog evidence proves each
 * column is absent, and reject any same-named column with an incompatible
 * declared type, nullability, or default value.
 *
 * Earlier startup code attempted every `ALTER TABLE` and caught every thrown
 * error as though it meant "column already exists". That could let a read-only,
 * corrupt, locked, or otherwise failing database continue booting with a
 * partially upgraded schema. Catalog-first idempotence removes the expected
 * duplicate-column error path. Exact catalog validation also prevents an old or
 * hand-modified database from entering service with a misleading same-name
 * column whose semantics do not match the application contract.
 *
 * @param {{exec: Function, prepare: Function}} database - node:sqlite-compatible database.
 * @returns {void}
 * @throws {TypeError} When the database adapter is missing required operations.
 * @throws {SchemaMigrationStateError} When an existing compatibility column is incompatible.
 */
export function ensureLegacyCompatibilityColumns(database) {
  if (!database || typeof database.exec !== 'function' || typeof database.prepare !== 'function') {
    throw new TypeError('database must provide exec and prepare');
  }

  for (const migration of LEGACY_COMPATIBILITY_COLUMNS) {
    const columns = database.prepare(`PRAGMA table_info(${migration.tableName})`).all();
    const existingColumn = columns.find((row) => String(row.name) === migration.columnName);
    if (existingColumn) {
      if (!matchesCompatibilityColumnContract(existingColumn, migration)) {
        throw new SchemaMigrationStateError(
          `legacy compatibility column definition mismatch: ${migration.tableName}.${migration.columnName}`,
        );
      }
      continue;
    }
    database.exec(`ALTER TABLE ${migration.tableName} ADD COLUMN ${migration.definition}`);
  }
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
 * @param {Iterable<{migrationKey: unknown, stateCode: unknown}>} rows - Persisted ledger rows.
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
 * object generations mixed. Repeated startup is idempotent and read-only once
 * the verified generation's ledger row exists, and a database that has ever
 * recorded the canonical generation cannot silently return to legacy tables
 * while retaining canonical migration history.
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
      migration_key TEXT PRIMARY KEY NOT NULL,
      state_code TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  validateMigrationLedgerSchema(database);

  const state = classifySchemaMigrationState(readApplicationTableNames(database));
  const existingRows = database.prepare(
    'SELECT migration_key AS migrationKey, state_code AS stateCode FROM schema_migrations ORDER BY migration_key',
  ).iterate();
  validateMigrationLedgerHistory(existingRows, state);

  const migrationKey = state === 'legacy_ready' ? 'legacy_schema_v1' : 'canonical_schema_v2';
  const ledgerStatement = database.prepare(
    'SELECT state_code AS stateCode FROM schema_migrations WHERE migration_key = ?',
  );
  let ledgerRow = ledgerStatement.get(migrationKey);
  if (!ledgerRow) {
    database.prepare(
      'INSERT OR IGNORE INTO schema_migrations(migration_key, state_code) VALUES (?, ?)',
    ).run(migrationKey, state);
    ledgerRow = ledgerStatement.get(migrationKey);
  }

  if (!ledgerRow || ledgerRow.stateCode !== state) {
    throw new SchemaMigrationStateError('schema migration ledger state does not match verified schema');
  }

  return state;
}
