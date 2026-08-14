import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  CANONICAL_SCHEMA_OBJECTS,
  LEGACY_SCHEMA_OBJECTS,
  SchemaMigrationStateError,
  classifySchemaMigrationState,
  ensureSchemaMigrationState,
  inspectSchemaBootstrapState,
} from '../../server/schema_migration.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

test('pre-bootstrap inspection permits only pristine or complete known generations', () => {
  assert.throws(() => inspectSchemaBootstrapState(null), /provide prepare/);

  const emptyDatabase = new DatabaseSync(':memory:');
  assert.equal(inspectSchemaBootstrapState(emptyDatabase), 'uninitialized');
  emptyDatabase.close();

  const legacyDatabase = new DatabaseSync(':memory:');
  createTables(legacyDatabase, LEGACY_SCHEMA_OBJECTS);
  assert.equal(inspectSchemaBootstrapState(legacyDatabase), 'legacy_ready');
  legacyDatabase.close();

  const canonicalDatabase = new DatabaseSync(':memory:');
  createTables(canonicalDatabase, CANONICAL_SCHEMA_OBJECTS);
  assert.equal(inspectSchemaBootstrapState(canonicalDatabase), 'canonical_ready');
  canonicalDatabase.close();

  const ledgerOnlyDatabase = new DatabaseSync(':memory:');
  ledgerOnlyDatabase.exec('CREATE TABLE schema_migrations (migration_key TEXT PRIMARY KEY)');
  assert.throws(
    () => inspectSchemaBootstrapState(ledgerOnlyDatabase),
    /partial or mixed schema migration state/,
  );
  ledgerOnlyDatabase.close();
});

test('database bootstrap never recreates legacy tables over a canonical generation', () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'scopeweave-schema-'));
  const databasePath = join(tempDirectory, 'canonical.sqlite');
  const database = new DatabaseSync(databasePath);
  createTables(database, CANONICAL_SCHEMA_OBJECTS);
  database.close();

  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', "await import('./server/db.mjs')"],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          SCOPEWEAVE_DB: databasePath,
          SCOPEWEAVE_JWT_SECRET: '0123456789abcdef0123456789abcdef',
        },
        encoding: 'utf8',
      },
    );

    assert.notEqual(result.status, 0, 'current application must fail closed on a canonical-only database');
    assert.match(
      result.stderr,
      /canonical schema generation is not yet supported by this application version/,
      'failure explains that query migration is still required instead of reporting a fabricated mixed schema',
    );

    const verificationDatabase = new DatabaseSync(databasePath);
    const names = new Set(
      verificationDatabase.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all().map((row) => String(row.name)),
    );
    verificationDatabase.close();

    assert.deepEqual(
      LEGACY_SCHEMA_OBJECTS.filter((name) => names.has(name)),
      [],
      'startup must not mutate a canonical database back toward the legacy generation',
    );
    assert.equal(names.has('schema_migrations'), true, 'the canonical generation is durably identified');
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
