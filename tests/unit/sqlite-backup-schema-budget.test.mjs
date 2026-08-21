import assert from 'node:assert/strict';
import { inspectOpenSqliteDatabase } from '../../server/sqlite_backup.mjs';

const MAX_ACCEPTED_SCHEMA_BYTES = 8 * 1024 * 1024;
const oversizedSql = `CREATE TABLE oversized_records(payload TEXT /*${'x'.repeat(MAX_ACCEPTED_SCHEMA_BYTES)}*/)`;
const oversizedSchemaRow = {
  type: 'table',
  name: 'oversized_records',
  tbl_name: 'oversized_records',
  sql: oversizedSql,
};

const fakeDatabase = {
  prepare(sql) {
    return {
      all() {
        if (sql === 'PRAGMA integrity_check') return [{ integrity_check: 'ok' }];
        if (sql === 'PRAGMA foreign_key_check') return [];
        throw new Error('schema metadata must be streamed instead of materialized with all()');
      },
      get() {
        return { application_id: 1, user_version: 1 };
      },
      *iterate() {
        yield oversizedSchemaRow;
      },
    };
  },
};

assert.throws(
  () => inspectOpenSqliteDatabase(fakeDatabase, 'source_database'),
  (error) => error?.code === 'source_database_schema_too_large',
  'schema verification must stream metadata and enforce its serialized byte budget before retaining all rows',
);

const foreignKeyViolationDatabase = {
  prepare(sql) {
    if (sql === 'PRAGMA integrity_check') {
      return { all: () => [{ integrity_check: 'ok' }] };
    }
    if (sql === 'PRAGMA foreign_key_check') {
      return {
        all() {
          throw new Error('foreign-key verification must not materialize an unbounded violation set');
        },
        *iterate() {
          yield { table: 'child_records', rowid: 1, parent: 'parent_records', fkid: 0 };
          throw new Error('foreign-key verification must stop after the first violation');
        },
      };
    }
    throw new Error(`unexpected SQL after foreign-key violation: ${sql}`);
  },
};

assert.throws(
  () => inspectOpenSqliteDatabase(foreignKeyViolationDatabase, 'source_database'),
  (error) => error?.code === 'source_database_foreign_key_failed',
  'foreign-key verification must stream violations and fail on the first row without materializing the full result set',
);

console.log('✓ SQLite schema and foreign-key streaming budget regressions passed');
