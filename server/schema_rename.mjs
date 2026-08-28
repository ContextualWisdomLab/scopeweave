import {
  CANONICAL_SCHEMA_OBJECTS,
  LEGACY_SCHEMA_OBJECTS,
  SchemaMigrationStateError,
  ensureSchemaMigrationState,
} from './schema_migration.mjs';

const SCHEMA_RENAME_PAIRS = Object.freeze([
  Object.freeze(['users', 'user_accounts']),
  Object.freeze(['orgs', 'organization_records']),
  Object.freeze(['memberships', 'organization_memberships']),
  Object.freeze(['projects', 'project_records']),
  Object.freeze(['invites', 'invitation_records']),
  Object.freeze(['webhooks', 'webhook_endpoints']),
  Object.freeze(['baselines', 'project_baselines']),
  Object.freeze(['comments', 'project_comments']),
  Object.freeze(['sprints', 'project_sprints']),
  Object.freeze(['attachments', 'project_attachments']),
]);

function readPragmaNumber(database, pragmaName) {
  const row = database.prepare(`PRAGMA ${pragmaName}`).get();
  return Number(row?.[pragmaName]);
}

function assertRenameContractMatchesMigrationCatalog() {
  const legacyNames = SCHEMA_RENAME_PAIRS.map(([legacyName]) => legacyName);
  const canonicalNames = SCHEMA_RENAME_PAIRS.map(([, canonicalName]) => canonicalName);
  if (legacyNames.length !== LEGACY_SCHEMA_OBJECTS.length
      || canonicalNames.length !== CANONICAL_SCHEMA_OBJECTS.length
      || legacyNames.some((name, index) => name !== LEGACY_SCHEMA_OBJECTS[index])
      || canonicalNames.some((name, index) => name !== CANONICAL_SCHEMA_OBJECTS[index])) {
    throw new SchemaMigrationStateError('canonical rename contract does not match schema migration catalog');
  }
}

function verifyDatabaseIntegrity(database) {
  const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length !== 0) {
    throw new SchemaMigrationStateError('canonical rename failed foreign-key integrity verification');
  }

  const integrity = database.prepare('PRAGMA integrity_check').get();
  if (String(integrity?.integrity_check ?? '') !== 'ok') {
    throw new SchemaMigrationStateError('canonical rename failed database integrity verification');
  }
}

/**
 * Atomically rename the legacy SQLite tables to ScopeWeave's canonical names.
 *
 * The cutover is deliberately isolated from application startup. It requires
 * foreign-key enforcement, disables SQLite's legacy ALTER TABLE behavior,
 * obtains an immediate write transaction, renames every owned table, appends
 * the canonical migration-ledger row, and verifies both foreign-key and general
 * database integrity before commit. Any failure after this function owns the
 * transaction rolls the complete cutover back. If BEGIN IMMEDIATE itself fails,
 * no rollback is attempted so a caller-owned transaction is never disturbed.
 * Re-running the function against an already canonical database is idempotent.
 *
 * @param {{exec: Function, prepare: Function}} database - node:sqlite-compatible database.
 * @returns {'canonical_ready'} Verified canonical schema state.
 * @throws {TypeError} When the database adapter is missing required operations.
 * @throws {SchemaMigrationStateError} When schema, pragma, ledger, or integrity evidence is invalid.
 */
export function runCanonicalSchemaRename(database) {
  if (!database || typeof database.exec !== 'function' || typeof database.prepare !== 'function') {
    throw new TypeError('database must provide exec and prepare');
  }

  assertRenameContractMatchesMigrationCatalog();

  if (readPragmaNumber(database, 'foreign_keys') !== 1) {
    throw new SchemaMigrationStateError('canonical rename requires PRAGMA foreign_keys = ON');
  }

  database.exec('PRAGMA legacy_alter_table = OFF');
  if (readPragmaNumber(database, 'legacy_alter_table') !== 0) {
    throw new SchemaMigrationStateError('canonical rename requires PRAGMA legacy_alter_table = OFF');
  }

  let ownsTransaction = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    ownsTransaction = true;

    const startingState = ensureSchemaMigrationState(database);
    if (startingState === 'canonical_ready') {
      verifyDatabaseIntegrity(database);
      database.exec('COMMIT');
      ownsTransaction = false;
      return 'canonical_ready';
    }

    for (const [legacyName, canonicalName] of SCHEMA_RENAME_PAIRS) {
      database.exec(`ALTER TABLE ${legacyName} RENAME TO ${canonicalName}`);
    }

    const completedState = ensureSchemaMigrationState(database);
    if (completedState !== 'canonical_ready') {
      throw new SchemaMigrationStateError('canonical rename did not produce the complete canonical schema');
    }

    verifyDatabaseIntegrity(database);
    database.exec('COMMIT');
    ownsTransaction = false;
    return 'canonical_ready';
  } catch (error) {
    if (ownsTransaction) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the causal migration failure; a failed rollback remains fail-closed.
      }
    }
    throw error;
  }
}
