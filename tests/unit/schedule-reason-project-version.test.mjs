import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createSqliteScheduleReasonProjectVersionAdapter,
  formatScheduleReasonResourceVersion,
} from '../../server/schedule_reason_event_project_version.mjs';
import {
  createSqliteScheduleReasonEventRepository,
  installScheduleReasonEventSchema,
} from '../../server/schedule_reason_event_sqlite.mjs';

function createDatabase({
  projectId = 41,
  organizationId = 7,
  version = 3,
  tasks = [{ id: 'work-item-01', task: 'Prepare cutover' }],
} = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      tasks_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  database.prepare(`
    INSERT INTO projects(id, org_id, tasks_json, version)
    VALUES(?, ?, ?, ?)
  `).run(projectId, organizationId, JSON.stringify(tasks), version);
  return database;
}

function request(overrides = {}) {
  return {
    organizationId: '7',
    projectId: '41',
    workItemId: 'work-item-01',
    expectedResourceVersion: 'project_version:3',
    ...overrides,
  };
}

function reasonEvent(overrides = {}) {
  return {
    eventId: 'evt-PROJECT-VERSION-01',
    contractVersion: 'schedule-reason-event/v1',
    organizationId: '7',
    projectId: '41',
    workItemId: 'work-item-01',
    expectedWorkItemVersion: 'project_version:3',
    type: 'skipped',
    reasonCode: 'duplicate_scope',
    actorId: 'user-owner-9',
    occurredAt: '2026-08-17T12:00:00.000Z',
    observedAt: '2026-08-17T13:00:00.000Z',
    authorizationId: 'authz-decision-22',
    approval: null,
    ...overrides,
  };
}

test('resource versions are canonical project-version tokens', () => {
  assert.equal(formatScheduleReasonResourceVersion(1), 'project_version:1');
  assert.equal(formatScheduleReasonResourceVersion(Number.MAX_SAFE_INTEGER), `project_version:${Number.MAX_SAFE_INTEGER}`);
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
    assert.throws(() => formatScheduleReasonResourceVersion(invalid), /project version must be a positive safe integer/);
  }
});

test('exact tenant, project, work item, and version advance atomically without rewriting task data', () => {
  const database = createDatabase();
  const originalTasks = database.prepare('SELECT tasks_json FROM projects WHERE id = 41').get().tasks_json;
  const adapter = createSqliteScheduleReasonProjectVersionAdapter(database);
  const result = adapter.advanceResourceVersion(request());
  assert.deepEqual(result, { advanced: true, resourceVersion: 'project_version:4' });
  assert.equal(Object.isFrozen(result), true);
  const row = database.prepare('SELECT org_id, tasks_json, version FROM projects WHERE id = 41').get();
  assert.equal(row.org_id, 7);
  assert.equal(row.version, 4);
  assert.equal(row.tasks_json, originalTasks);
  database.close();
});

test('stale, cross-tenant, cross-project, and unknown-work-item transitions fail closed', () => {
  const cases = [
    request({ expectedResourceVersion: 'project_version:2' }),
    request({ organizationId: '8' }),
    request({ projectId: '42' }),
    request({ workItemId: 'work-item-missing' }),
  ];
  for (const candidate of cases) {
    const database = createDatabase();
    const adapter = createSqliteScheduleReasonProjectVersionAdapter(database);
    assert.deepEqual(adapter.advanceResourceVersion(candidate), { advanced: false });
    assert.equal(database.prepare('SELECT version FROM projects WHERE id = 41').get().version, 3);
    database.close();
  }
});

test('adapter rejects ambiguous database identities and malformed version authority before mutation', () => {
  const database = createDatabase();
  const adapter = createSqliteScheduleReasonProjectVersionAdapter(database);
  const invalidRequests = [
    request({ organizationId: '07' }),
    request({ organizationId: '+7' }),
    request({ organizationId: ' 7' }),
    request({ projectId: '041' }),
    request({ projectId: '4.1e1' }),
    request({ expectedResourceVersion: 'project_version:03' }),
    request({ expectedResourceVersion: '3' }),
    request({ expectedResourceVersion: 'project_version:0' }),
    request({ workItemId: '' }),
    request({ workItemId: '   ' }),
    request({ workItemId: 'x'.repeat(257) }),
  ];
  for (const candidate of invalidRequests) {
    assert.throws(() => adapter.advanceResourceVersion(candidate));
    assert.equal(database.prepare('SELECT version FROM projects WHERE id = 41').get().version, 3);
  }
  database.close();
});

test('malformed or ambiguous task containers fail closed without advancing authority', () => {
  const malformedDatabase = createDatabase();
  malformedDatabase.prepare('UPDATE projects SET tasks_json = ? WHERE id = 41').run('{bad-json');
  const malformedAdapter = createSqliteScheduleReasonProjectVersionAdapter(malformedDatabase);
  assert.throws(() => malformedAdapter.advanceResourceVersion(request()), /project tasks_json is invalid/);
  assert.equal(malformedDatabase.prepare('SELECT version FROM projects WHERE id = 41').get().version, 3);
  malformedDatabase.close();

  const duplicateDatabase = createDatabase({ tasks: [
    { id: 'work-item-01', task: 'First copy' },
    { id: 'work-item-01', task: 'Duplicate copy' },
  ] });
  const duplicateAdapter = createSqliteScheduleReasonProjectVersionAdapter(duplicateDatabase);
  assert.throws(() => duplicateAdapter.advanceResourceVersion(request()), /project tasks_json contains duplicate work-item identity/);
  assert.equal(duplicateDatabase.prepare('SELECT version FROM projects WHERE id = 41').get().version, 3);
  duplicateDatabase.close();
});

test('one successful transition makes the predecessor version unusable on the next attempt', () => {
  const database = createDatabase();
  const adapter = createSqliteScheduleReasonProjectVersionAdapter(database);
  assert.deepEqual(adapter.advanceResourceVersion(request()), { advanced: true, resourceVersion: 'project_version:4' });
  assert.deepEqual(adapter.advanceResourceVersion(request()), { advanced: false });
  assert.equal(database.prepare('SELECT version FROM projects WHERE id = 41').get().version, 4);
  database.close();
});

test('maximum safe project version cannot be advanced into an unsafe integer', () => {
  const database = createDatabase({ version: Number.MAX_SAFE_INTEGER });
  const adapter = createSqliteScheduleReasonProjectVersionAdapter(database);
  assert.throws(
    () => adapter.advanceResourceVersion(request({ expectedResourceVersion: `project_version:${Number.MAX_SAFE_INTEGER}` })),
    /project version cannot advance beyond the safe integer range/,
  );
  assert.equal(database.prepare('SELECT version FROM projects WHERE id = 41').get().version, Number.MAX_SAFE_INTEGER);
  database.close();
});

test('real reason-event savepoint rolls the authoritative project version back when audit persistence fails', async () => {
  const database = createDatabase();
  database.exec('PRAGMA foreign_keys = ON');
  installScheduleReasonEventSchema(database);
  const versionAdapter = createSqliteScheduleReasonProjectVersionAdapter(database);
  const repository = createSqliteScheduleReasonEventRepository(database, {
    advanceResourceVersion: versionAdapter.advanceResourceVersion,
    nextAuditRecordId: () => 'audit-project-version-fixed',
  });

  await repository.commitReasonEvent({
    event: reasonEvent(),
    expectedResourceVersion: 'project_version:3',
  });
  assert.equal(database.prepare('SELECT version FROM projects WHERE id = 41').get().version, 4);

  database.prepare('UPDATE projects SET version = 3 WHERE id = 41').run();
  await assert.rejects(
    repository.commitReasonEvent({
      event: reasonEvent({ eventId: 'evt-PROJECT-VERSION-02' }),
      expectedResourceVersion: 'project_version:3',
    }),
    /UNIQUE constraint failed: schedule_reason_event_audit_records.audit_record_id/,
  );

  assert.equal(database.prepare('SELECT version FROM projects WHERE id = 41').get().version, 3);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schedule_reason_events').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schedule_reason_event_audit_records').get().count, 1);
  database.close();
});
