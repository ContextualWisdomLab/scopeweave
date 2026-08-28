import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  CANONICAL_SCHEMA_OBJECTS,
  LEGACY_SCHEMA_OBJECTS,
  SchemaMigrationStateError,
} from '../../server/schema_migration.mjs';
import { runCanonicalSchemaRename } from '../../server/schema_rename.mjs';

const RENAME_PAIRS = Object.freeze([
  ['users', 'user_accounts'],
  ['orgs', 'organization_records'],
  ['memberships', 'organization_memberships'],
  ['projects', 'project_records'],
  ['invites', 'invitation_records'],
  ['webhooks', 'webhook_endpoints'],
  ['baselines', 'project_baselines'],
  ['comments', 'project_comments'],
  ['sprints', 'project_sprints'],
  ['attachments', 'project_attachments'],
]);

function createPopulatedLegacyDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL
    );
    CREATE TABLE orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE memberships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      org_id TEXT NOT NULL REFERENCES orgs(id)
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id),
      name TEXT NOT NULL
    );
    CREATE TABLE invites (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(id)
    );
    CREATE TABLE webhooks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id)
    );
    CREATE TABLE baselines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id)
    );
    CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id)
    );
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id)
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id)
    );
    CREATE TABLE schema_migrations (
      migration_key TEXT PRIMARY KEY NOT NULL,
      state_code TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations(migration_key, state_code)
    VALUES ('legacy_schema_v1', 'legacy_ready');

    INSERT INTO users(id, email) VALUES ('user-1', 'buyer@example.test');
    INSERT INTO orgs(id, name) VALUES ('org-1', 'Acquirer');
    INSERT INTO memberships(id, user_id, org_id) VALUES ('membership-1', 'user-1', 'org-1');
    INSERT INTO projects(id, org_id, name) VALUES ('project-1', 'org-1', 'Migration rehearsal');
    INSERT INTO invites(id, org_id) VALUES ('invite-1', 'org-1');
    INSERT INTO webhooks(id, project_id) VALUES ('webhook-1', 'project-1');
    INSERT INTO baselines(id, project_id) VALUES ('baseline-1', 'project-1');
    INSERT INTO comments(id, project_id) VALUES ('comment-1', 'project-1');
    INSERT INTO sprints(id, project_id) VALUES ('sprint-1', 'project-1');
    INSERT INTO attachments(id, project_id) VALUES ('attachment-1', 'project-1');
  `);
  return database;
}

function tableNames(database) {
  return new Set(database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((row) => String(row.name)));
}

function foreignKeyTargets(database, tableName) {
  return new Set(database.prepare(`PRAGMA foreign_key_list(${tableName})`).all()
    .map((row) => String(row.table)));
}

test('canonical rename preserves populated rows and rewrites foreign-key targets atomically', () => {
  const database = createPopulatedLegacyDatabase();

  assert.equal(runCanonicalSchemaRename(database), 'canonical_ready');

  const names = tableNames(database);
  for (const legacyName of LEGACY_SCHEMA_OBJECTS) assert.equal(names.has(legacyName), false);
  for (const canonicalName of CANONICAL_SCHEMA_OBJECTS) assert.equal(names.has(canonicalName), true);
  assert.equal(names.has('schema_migrations'), true);

  assert.deepEqual(
    database.prepare('SELECT id, email FROM user_accounts').get(),
    { id: 'user-1', email: 'buyer@example.test' },
  );
  assert.deepEqual(
    database.prepare('SELECT id, name FROM organization_records').get(),
    { id: 'org-1', name: 'Acquirer' },
  );
  assert.deepEqual(
    database.prepare('SELECT id, name FROM project_records').get(),
    { id: 'project-1', name: 'Migration rehearsal' },
  );
  assert.deepEqual(
    foreignKeyTargets(database, 'organization_memberships'),
    new Set(['user_accounts', 'organization_records']),
  );
  assert.deepEqual(foreignKeyTargets(database, 'webhook_endpoints'), new Set(['project_records']));
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(
    database.prepare(
      'SELECT migration_key AS migrationKey, state_code AS stateCode FROM schema_migrations ORDER BY migration_key',
    ).all(),
    [
      { migrationKey: 'canonical_schema_v2', stateCode: 'canonical_ready' },
      { migrationKey: 'legacy_schema_v1', stateCode: 'legacy_ready' },
    ],
  );

  database.close();
});

test('canonical rename is idempotent after the complete canonical generation is committed', () => {
  const database = createPopulatedLegacyDatabase();
  assert.equal(runCanonicalSchemaRename(database), 'canonical_ready');
  assert.equal(runCanonicalSchemaRename(database), 'canonical_ready');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM user_accounts').get().count, 1);
  database.close();
});

test('canonical rename refuses to run unless foreign-key enforcement is enabled', () => {
  const database = createPopulatedLegacyDatabase();
  database.exec('PRAGMA foreign_keys = OFF');

  assert.throws(
    () => runCanonicalSchemaRename(database),
    (error) => error instanceof SchemaMigrationStateError && /foreign_keys/.test(error.message),
  );
  const names = tableNames(database);
  for (const legacyName of LEGACY_SCHEMA_OBJECTS) assert.equal(names.has(legacyName), true);
  for (const canonicalName of CANONICAL_SCHEMA_OBJECTS) assert.equal(names.has(canonicalName), false);
  database.close();
});

test('canonical rename rolls every table rename and canonical ledger row back after a mid-cutover failure', () => {
  const database = createPopulatedLegacyDatabase();
  const adapter = {
    exec(sql) {
      if (/ALTER TABLE projects RENAME TO project_records/.test(sql)) {
        throw new Error('injected rename failure');
      }
      return database.exec(sql);
    },
    prepare(sql) {
      return database.prepare(sql);
    },
  };

  assert.throws(() => runCanonicalSchemaRename(adapter), /injected rename failure/);

  const names = tableNames(database);
  for (const legacyName of LEGACY_SCHEMA_OBJECTS) assert.equal(names.has(legacyName), true);
  for (const canonicalName of CANONICAL_SCHEMA_OBJECTS) assert.equal(names.has(canonicalName), false);
  assert.deepEqual(
    database.prepare(
      'SELECT migration_key AS migrationKey, state_code AS stateCode FROM schema_migrations ORDER BY migration_key',
    ).all(),
    [{ migrationKey: 'legacy_schema_v1', stateCode: 'legacy_ready' }],
  );
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  database.close();
});

test('canonical rename validates the database adapter before attempting a migration', () => {
  assert.throws(() => runCanonicalSchemaRename(null), /exec and prepare/);
  assert.throws(() => runCanonicalSchemaRename({ exec() {} }), /exec and prepare/);
  assert.throws(() => runCanonicalSchemaRename({ prepare() {} }), /exec and prepare/);
});

test('canonical rename does not roll back a caller-owned transaction when BEGIN IMMEDIATE cannot start', () => {
  const database = createPopulatedLegacyDatabase();
  database.exec('BEGIN');

  assert.throws(() => runCanonicalSchemaRename(database), /transaction|within a transaction|cannot start/i);
  database.exec("INSERT INTO users(id, email) VALUES ('user-2', 'still-open@example.test')");
  database.exec('ROLLBACK');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = 'user-2'").get().count, 0);

  database.close();
});
