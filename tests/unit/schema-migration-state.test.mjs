import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  CANONICAL_SCHEMA_OBJECTS,
  LEGACY_SCHEMA_OBJECTS,
  SchemaMigrationStateError,
  classifySchemaMigrationState,
  ensureSchemaMigrationState,
} from '../../server/schema_migration.mjs';

function createTables(db, names) {
  for (const name of names) {
    db.exec(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`);
  }
}

function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

test('legacy schema gets an idempotent migration-ledger record', () => {
  const db = new DatabaseSync(':memory:');
  createTables(db, LEGACY_SCHEMA_OBJECTS);

  assert.equal(ensureSchemaMigrationState(db), 'legacy_ready');
  assert.equal(ensureSchemaMigrationState(db), 'legacy_ready');

  const ledger = plainRows(db.prepare(
    'SELECT migration_key AS migrationKey, state_code AS stateCode FROM schema_migrations ORDER BY migration_key',
  ).all());
  assert.deepEqual(ledger, [
    { migrationKey: 'legacy_schema_v1', stateCode: 'legacy_ready' },
  ]);
  db.close();
});

test('canonical schema gets a distinct append-only migration-ledger record', () => {
  const db = new DatabaseSync(':memory:');
  createTables(db, CANONICAL_SCHEMA_OBJECTS);

  assert.equal(ensureSchemaMigrationState(db), 'canonical_ready');
  const ledger = plainRows(db.prepare(
    'SELECT migration_key AS migrationKey, state_code AS stateCode FROM schema_migrations',
  ).all());
  assert.deepEqual(ledger, [
    { migrationKey: 'canonical_schema_v2', stateCode: 'canonical_ready' },
  ]);
  db.close();
});

test('mixed or incomplete schemas fail closed before service use', () => {
  const db = new DatabaseSync(':memory:');
  createTables(db, LEGACY_SCHEMA_OBJECTS);
  db.exec('ALTER TABLE users RENAME TO user_accounts');

  assert.throws(
    () => ensureSchemaMigrationState(db),
    (error) => error instanceof SchemaMigrationStateError
      && /partial or mixed schema migration state/.test(error.message),
  );
  db.close();
});

test('corrupted migration-ledger state cannot bless a verified schema', () => {
  const db = new DatabaseSync(':memory:');
  createTables(db, LEGACY_SCHEMA_OBJECTS);
  db.exec(`
    CREATE TABLE schema_migrations (
      migration_key TEXT PRIMARY KEY,
      state_code TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations(migration_key, state_code)
    VALUES ('legacy_schema_v1', 'canonical_ready');
  `);

  assert.throws(
    () => ensureSchemaMigrationState(db),
    (error) => error instanceof SchemaMigrationStateError
      && /ledger state does not match verified schema/.test(error.message),
  );
  db.close();
});

test('migration guard rejects adapters missing required database operations', () => {
  assert.throws(() => ensureSchemaMigrationState(null), /exec and prepare/);
  assert.throws(() => ensureSchemaMigrationState({ prepare() {} }), /exec and prepare/);
  assert.throws(() => ensureSchemaMigrationState({ exec() {} }), /exec and prepare/);
});

test('schema-state classifier rejects unusable inputs and names every expected object', () => {
  assert.equal(classifySchemaMigrationState(new Set(LEGACY_SCHEMA_OBJECTS)), 'legacy_ready');
  assert.equal(classifySchemaMigrationState(new Set(CANONICAL_SCHEMA_OBJECTS)), 'canonical_ready');
  assert.throws(() => classifySchemaMigrationState([]), /Set/);
  assert.throws(() => classifySchemaMigrationState(new Set()), /partial or mixed/);
  assert.equal(new Set(LEGACY_SCHEMA_OBJECTS).size, 10);
  assert.equal(new Set(CANONICAL_SCHEMA_OBJECTS).size, 10);
});
