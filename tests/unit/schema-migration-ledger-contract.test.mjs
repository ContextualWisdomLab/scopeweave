import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  LEGACY_SCHEMA_OBJECTS,
  SchemaMigrationStateError,
  ensureSchemaMigrationState,
} from '../../server/schema_migration.mjs';

function createLegacyGeneration(database) {
  for (const tableName of LEGACY_SCHEMA_OBJECTS) {
    database.exec(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY)`);
  }
}

test('migration ledger fails closed when its persisted schema cannot enforce identity', () => {
  const database = new DatabaseSync(':memory:');
  createLegacyGeneration(database);
  database.exec(`
    CREATE TABLE schema_migrations (
      migration_key TEXT,
      state_code TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations(migration_key, state_code)
    VALUES ('legacy_schema_v1', 'legacy_ready');
  `);

  assert.throws(
    () => ensureSchemaMigrationState(database),
    (error) => error instanceof SchemaMigrationStateError
      && /migration ledger schema/.test(error.message),
    'startup must not trust a ledger that cannot enforce unique migration identity and required fields',
  );

  database.close();
});

test('migration ledger fails closed when its application timestamp default has drifted', () => {
  const database = new DatabaseSync(':memory:');
  createLegacyGeneration(database);
  database.exec(`
    CREATE TABLE schema_migrations (
      migration_key TEXT PRIMARY KEY NOT NULL,
      state_code TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations(migration_key, state_code, applied_at)
    VALUES ('legacy_schema_v1', 'legacy_ready', '2026-08-21T00:00:00Z');
  `);

  assert.throws(
    () => ensureSchemaMigrationState(database),
    (error) => error instanceof SchemaMigrationStateError
      && /migration ledger schema/.test(error.message),
    'startup must reject a persisted ledger that no longer supplies the required application timestamp default',
  );

  database.close();
});

test('established migration ledger startup does not execute redundant ledger DDL', () => {
  const database = new DatabaseSync(':memory:');
  createLegacyGeneration(database);
  database.exec(`
    CREATE TABLE schema_migrations (
      migration_key TEXT PRIMARY KEY NOT NULL,
      state_code TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations(migration_key, state_code)
    VALUES ('legacy_schema_v1', 'legacy_ready');
  `);

  const databaseAdapter = {
    exec(sql) {
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) {
        throw new Error('established startup must not execute redundant migration-ledger DDL');
      }
      return database.exec(sql);
    },
    prepare(sql) {
      return database.prepare(sql);
    },
  };

  assert.equal(
    ensureSchemaMigrationState(databaseAdapter),
    'legacy_ready',
    'an already-valid migration ledger must be verified without depending on no-op CREATE locking semantics',
  );

  database.close();
});
