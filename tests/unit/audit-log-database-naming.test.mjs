import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const REQUIRED_AUDIT_COLUMNS = new Set([
  'audit_event_id',
  'org_id',
  'user_id',
  'audit_action',
  'target_type',
  'target_id',
  'audit_metadata_json',
  'created_at',
]);
const LEGACY_AUDIT_COLUMNS = ['id', 'action', 'meta'];

function readAuditColumnNames(databaseConnection) {
  return new Set(
    databaseConnection
      .prepare("PRAGMA table_info('audit_log')")
      .all()
      .map((columnRecord) => columnRecord.name),
  );
}

function assertSemanticAuditSchema(databaseConnection) {
  const auditColumnNames = readAuditColumnNames(databaseConnection);
  for (const requiredColumnName of REQUIRED_AUDIT_COLUMNS) {
    assert.ok(
      auditColumnNames.has(requiredColumnName),
      `audit_log must expose semantic column ${requiredColumnName}`,
    );
  }
  for (const legacyColumnName of LEGACY_AUDIT_COLUMNS) {
    assert.equal(
      auditColumnNames.has(legacyColumnName),
      false,
      `audit_log must not retain generic legacy column ${legacyColumnName}`,
    );
  }
}

async function importDatabaseModule(databasePath, importLabel) {
  process.env.SCOPEWEAVE_DB = databasePath;
  return import(`../../server/db.mjs?audit-semantic-naming=${importLabel}`);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scopeweave-audit-naming-'));
try {
  const freshDatabasePath = join(temporaryDirectory, 'fresh.db');
  const freshDatabaseModule = await importDatabaseModule(freshDatabasePath, 'fresh');
  assertSemanticAuditSchema(freshDatabaseModule.db);
  freshDatabaseModule.db.close();

  const legacyDatabasePath = join(temporaryDirectory, 'legacy.db');
  const legacyDatabaseConnection = new DatabaseSync(legacyDatabasePath);
  legacyDatabaseConnection.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      user_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      meta TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_audit_org ON audit_log(org_id, id);
    INSERT INTO audit_log(
      id, org_id, user_id, action, target_type, target_id, meta, created_at
    ) VALUES (
      17, 23, 29, 'project.update', 'project', '31', '{"version":4}',
      '2026-09-02T00:00:00Z'
    );
  `);
  legacyDatabaseConnection.close();

  const migratedDatabaseModule = await importDatabaseModule(legacyDatabasePath, 'legacy');
  assertSemanticAuditSchema(migratedDatabaseModule.db);
  const migratedAuditEvent = migratedDatabaseModule.db
    .prepare(`
      SELECT audit_event_id, org_id, user_id, audit_action, target_type, target_id,
             audit_metadata_json, created_at
      FROM audit_log
    `)
    .get();
  assert.deepEqual(migratedAuditEvent, {
    audit_event_id: 17,
    org_id: 23,
    user_id: 29,
    audit_action: 'project.update',
    target_type: 'project',
    target_id: '31',
    audit_metadata_json: '{"version":4}',
    created_at: '2026-09-02T00:00:00Z',
  });

  const auditIndexNames = migratedDatabaseModule.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'")
    .all()
    .map((indexRecord) => indexRecord.name);
  assert.ok(auditIndexNames.includes('audit_log_org_event_idx'));
  assert.equal(auditIndexNames.includes('idx_audit_org'), false);
  migratedDatabaseModule.db.close();
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('✓ audit-log semantic database naming tests passed');
