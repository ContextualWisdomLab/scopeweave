import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  ensureLegacyCompatibilityColumns,
  SchemaMigrationStateError,
} from '../../server/schema_migration.mjs';

function columnNames(database, tableName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row.name));
}

test('legacy compatibility columns are added idempotently from catalog evidence', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE projects (id INTEGER PRIMARY KEY);
  `);

  ensureLegacyCompatibilityColumns(database);
  ensureLegacyCompatibilityColumns(database);

  assert.deepEqual(columnNames(database, 'users'), ['id', 'token_version']);
  assert.deepEqual(columnNames(database, 'projects'), ['id', 'archived', 'methodology']);

  const user = database.prepare('INSERT INTO users DEFAULT VALUES RETURNING token_version').get();
  const project = database.prepare('INSERT INTO projects DEFAULT VALUES RETURNING archived, methodology').get();
  assert.equal(user.token_version, 0);
  assert.equal(project.archived, 0);
  assert.equal(project.methodology, 'waterfall');
  database.close();
});

test('legacy compatibility migration rejects incompatible existing column definitions', () => {
  const cases = [
    {
      label: 'wrong type',
      ddl: `
        CREATE TABLE users (id INTEGER PRIMARY KEY, token_version TEXT NOT NULL DEFAULT 0);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          archived INTEGER NOT NULL DEFAULT 0,
          methodology TEXT NOT NULL DEFAULT 'waterfall'
        );
      `,
    },
    {
      label: 'nullable column',
      ddl: `
        CREATE TABLE users (id INTEGER PRIMARY KEY, token_version INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          archived INTEGER DEFAULT 0,
          methodology TEXT NOT NULL DEFAULT 'waterfall'
        );
      `,
    },
    {
      label: 'wrong default',
      ddl: `
        CREATE TABLE users (id INTEGER PRIMARY KEY, token_version INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          archived INTEGER NOT NULL DEFAULT 0,
          methodology TEXT NOT NULL DEFAULT 'agile'
        );
      `,
    },
  ];

  for (const { label, ddl } of cases) {
    const database = new DatabaseSync(':memory:');
    database.exec(ddl);
    assert.throws(
      () => ensureLegacyCompatibilityColumns(database),
      (error) => error instanceof SchemaMigrationStateError,
      label,
    );
    database.close();
  }
});

test('legacy compatibility migration propagates real database failures instead of treating them as already applied', () => {
  const failure = new Error('disk I/O error');
  const database = {
    prepare() {
      return { all: () => [] };
    },
    exec() {
      throw failure;
    },
  };

  assert.throws(
    () => ensureLegacyCompatibilityColumns(database),
    (error) => error === failure,
  );
});

test('legacy compatibility migration rejects incomplete database adapters', () => {
  assert.throws(() => ensureLegacyCompatibilityColumns(null), /exec and prepare/);
  assert.throws(() => ensureLegacyCompatibilityColumns({ exec() {} }), /exec and prepare/);
  assert.throws(() => ensureLegacyCompatibilityColumns({ prepare() {} }), /exec and prepare/);
  assert.throws(
    () => ensureLegacyCompatibilityColumns({ exec: true, prepare() {} }),
    /exec and prepare/,
  );
  assert.throws(
    () => ensureLegacyCompatibilityColumns({ exec() {}, prepare: {} }),
    /exec and prepare/,
  );
});
