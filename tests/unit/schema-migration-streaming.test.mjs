import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_SCHEMA_OBJECTS,
  ensureSchemaMigrationState,
  inspectSchemaBootstrapState,
  runAtomicLegacySchemaBootstrap,
} from '../../server/schema_migration.mjs';

function legacyCatalogRows() {
  return [
    ...LEGACY_SCHEMA_OBJECTS.map((name) => ({ name })),
    { name: 'schema_migrations' },
    { name: 'unrelated_extension_table' },
  ];
}

function migrationLedgerColumnRows() {
  return [
    { name: 'migration_key', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'state_code', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'applied_at', type: 'TEXT', notnull: 1, pk: 0, dflt_value: "datetime('now')" },
  ];
}

test('schema bootstrap streams catalog rows instead of materializing an unbounded catalog', () => {
  const fakeDatabase = {
    prepare(sql) {
      assert.match(sql, /FROM sqlite_master/);
      return {
        all() {
          throw new Error('schema catalog must be streamed instead of materialized with all()');
        },
        *iterate() {
          yield* legacyCatalogRows();
        },
      };
    },
  };

  assert.equal(inspectSchemaBootstrapState(fakeDatabase), 'legacy_ready');
});

test('established legacy schema still runs additive idempotent bootstrap DDL without an explicit write reservation', () => {
  const bootstrapSql = 'CREATE TABLE IF NOT EXISTS auxiliary_runtime_state (id INTEGER PRIMARY KEY);';
  const execCalls = [];
  const fakeDatabase = {
    exec(sql) {
      execCalls.push(sql);
    },
    prepare(sql) {
      assert.match(sql, /FROM sqlite_master/);
      return {
        *iterate() {
          yield* LEGACY_SCHEMA_OBJECTS.map((name) => ({ name }));
        },
      };
    },
  };

  runAtomicLegacySchemaBootstrap(fakeDatabase, bootstrapSql);

  assert.deepEqual(
    execCalls,
    [bootstrapSql],
    'existing legacy databases must receive additive CREATE IF NOT EXISTS DDL without BEGIN IMMEDIATE',
  );
});

test('schema migration ledger streams persisted rows and rejects materialization', () => {
  let insertObserved = false;
  const catalogRows = legacyCatalogRows();
  const fakeDatabase = {
    exec(sql) {
      assert.match(sql, /CREATE TABLE IF NOT EXISTS schema_migrations/);
    },
    prepare(sql) {
      if (sql.includes('FROM sqlite_master')) {
        return {
          all: () => catalogRows,
          *iterate() {
            yield* catalogRows;
          },
        };
      }
      if (sql === 'PRAGMA table_info(schema_migrations)') {
        return {
          all() {
            throw new Error('migration ledger schema must be streamed instead of materialized with all()');
          },
          *iterate() {
            yield* migrationLedgerColumnRows();
          },
        };
      }
      if (sql.includes('SELECT migration_key AS migrationKey')) {
        return {
          all() {
            throw new Error('migration ledger must be streamed instead of materialized with all()');
          },
          *iterate() {
            yield { migrationKey: 'legacy_schema_v1', stateCode: 'legacy_ready' };
          },
        };
      }
      if (sql.startsWith('INSERT OR IGNORE INTO schema_migrations')) {
        return {
          run(migrationKey, stateCode) {
            assert.equal(migrationKey, 'legacy_schema_v1');
            assert.equal(stateCode, 'legacy_ready');
            insertObserved = true;
          },
        };
      }
      if (sql.includes('SELECT state_code AS stateCode')) {
        return {
          get(migrationKey) {
            assert.equal(migrationKey, 'legacy_schema_v1');
            return { stateCode: 'legacy_ready' };
          },
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  assert.equal(ensureSchemaMigrationState(fakeDatabase), 'legacy_ready');
  assert.equal(
    insertObserved,
    false,
    'an already-persisted migration row must be streamed and reused without a redundant insert',
  );
});
