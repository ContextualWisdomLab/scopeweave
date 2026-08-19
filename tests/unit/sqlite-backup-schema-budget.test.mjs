import assert from 'node:assert/strict';
import { inspectOpenSqliteDatabase } from '../../server/sqlite_backup.mjs';

const MAX_ACCEPTED_SCHEMA_BYTES = 8 * 1024 * 1024;
const oversizedSql = `CREATE TABLE oversized_records(payload TEXT /*${'x'.repeat(MAX_ACCEPTED_SCHEMA_BYTES)}*/)`;

const fakeDatabase = {
  prepare(sql) {
    return {
      all() {
        if (sql === 'PRAGMA integrity_check') return [{ integrity_check: 'ok' }];
        if (sql === 'PRAGMA foreign_key_check') return [];
        return [{
          type: 'table',
          name: 'oversized_records',
          tbl_name: 'oversized_records',
          sql: oversizedSql,
        }];
      },
      get() {
        return { application_id: 1, user_version: 1 };
      },
    };
  },
};

assert.throws(
  () => inspectOpenSqliteDatabase(fakeDatabase, 'source_database'),
  (error) => error?.code === 'source_database_schema_too_large',
  'schema verification must bound metadata bytes as well as object count',
);

console.log('✓ SQLite schema byte budget regression passed');
