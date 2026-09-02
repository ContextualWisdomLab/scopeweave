import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const REQUIRED_AUDIT_EVENT_COLUMNS = new Set([
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

function readAuditEventColumnNames(databaseConnection) {
  return new Set(
    databaseConnection
      .prepare("PRAGMA main.table_info('audit_events')")
      .all()
      .map((columnRecord) => columnRecord.name),
  );
}

function assertSemanticAuditPersistence(databaseConnection) {
  const auditEventColumnNames = readAuditEventColumnNames(databaseConnection);
  for (const requiredColumnName of REQUIRED_AUDIT_EVENT_COLUMNS) {
    assert.ok(
      auditEventColumnNames.has(requiredColumnName),
      `audit_events must expose semantic column ${requiredColumnName}`,
    );
  }
  for (const legacyColumnName of LEGACY_AUDIT_COLUMNS) {
    assert.equal(
      auditEventColumnNames.has(legacyColumnName),
      false,
      `audit_events must not retain generic legacy column ${legacyColumnName}`,
    );
  }

  const durableAuditLogObject = databaseConnection
    .prepare("SELECT type FROM main.sqlite_master WHERE name = 'audit_log'")
    .get();
  assert.equal(durableAuditLogObject, undefined, 'legacy audit_log must not remain durable');
  const compatibilityView = databaseConnection
    .prepare("SELECT type FROM temp.sqlite_temp_master WHERE name = 'audit_log'")
    .get();
  assert.equal(compatibilityView?.type, 'view', 'legacy wire names stay in a TEMP adapter view');
}

async function importDatabaseModule(databasePath, importLabel) {
  process.env.SCOPEWEAVE_DB = databasePath;
  return import(`../../server/db.mjs?audit-semantic-naming=${importLabel}`);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scopeweave-audit-naming-'));
try {
  const freshDatabasePath = join(temporaryDirectory, 'fresh.db');
  const freshDatabaseModule = await importDatabaseModule(freshDatabasePath, 'fresh');
  assertSemanticAuditPersistence(freshDatabaseModule.db);

  freshDatabaseModule.db.prepare(`
    INSERT INTO audit_log(org_id, user_id, action, target_type, target_id, meta)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(3, null, 'project.create', 'project', '5', '{"projectName":"P1"}');
  const compatibilityAuditEvent = freshDatabaseModule.db.prepare(`
    SELECT id, action, meta FROM audit_log WHERE org_id = ?
  `).get(3);
  assert.deepEqual(compatibilityAuditEvent, {
    id: 1,
    action: 'project.create',
    meta: '{"projectName":"P1"}',
  });
  const durableAuditEvent = freshDatabaseModule.db.prepare(`
    SELECT audit_event_id, audit_action, audit_metadata_json
    FROM main.audit_events WHERE org_id = ?
  `).get(3);
  assert.deepEqual(durableAuditEvent, {
    audit_event_id: 1,
    audit_action: 'project.create',
    audit_metadata_json: '{"projectName":"P1"}',
  });
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
  assertSemanticAuditPersistence(migratedDatabaseModule.db);
  const migratedAuditEvent = migratedDatabaseModule.db
    .prepare(`
      SELECT audit_event_id, org_id, user_id, audit_action, target_type, target_id,
             audit_metadata_json, created_at
      FROM main.audit_events
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
    .prepare("SELECT name FROM main.sqlite_master WHERE type = 'index' AND tbl_name = 'audit_events'")
    .all()
    .map((indexRecord) => indexRecord.name);
  assert.ok(auditIndexNames.includes('audit_events_org_event_idx'));
  assert.equal(auditIndexNames.includes('idx_audit_org'), false);
  migratedDatabaseModule.db.close();
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('✓ audit-log semantic database naming tests passed');
