import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createSqliteScheduleReasonEventRepository,
  installScheduleReasonEventSchema,
} from '../../server/schedule_reason_event_sqlite.mjs';

const baseEvent = (overrides = {}) => ({
  eventId: 'evt-01HZY7R8ABCDE12345',
  contractVersion: 'schedule-reason-event/v1',
  organizationId: 'org-tenant-a',
  projectId: 'project-alpha',
  workItemId: 'task-17',
  expectedWorkItemVersion: 'work-v7',
  type: 'skipped',
  reasonCode: 'duplicate_scope',
  actorId: 'user-owner-9',
  occurredAt: '2026-08-15T22:00:00.000Z',
  observedAt: '2026-08-15T23:00:00.000Z',
  authorizationId: 'authz-decision-22',
  approval: null,
  ...overrides,
});

function newDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function setup(overrides = {}) {
  const db = newDatabase();
  installScheduleReasonEventSchema(db);
  const transitions = [];
  let auditCounter = 0;
  const dependencies = {
    advanceResourceVersion: (binding) => {
      transitions.push(binding);
      return { advanced: true, resourceVersion: 'work-v8' };
    },
    nextAuditRecordId: () => `audit-record-${++auditCounter}`,
    ...overrides,
  };
  return {
    db,
    transitions,
    repository: createSqliteScheduleReasonEventRepository(db, dependencies),
  };
}

test('installs normalized durable event and audit relations with descriptive names', () => {
  const db = newDatabase();
  installScheduleReasonEventSchema(db);
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name LIKE 'schedule_reason_%'
     ORDER BY name
  `).all().map(({ name }) => name);
  assert.deepEqual(tables, [
    'schedule_reason_event_approval_records',
    'schedule_reason_event_audit_records',
    'schedule_reason_events',
  ]);
  const indexes = db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'index' AND name LIKE 'schedule_reason_%' AND sql IS NOT NULL
     ORDER BY name
  `).all().map(({ name }) => name);
  assert.deepEqual(indexes, [
    'schedule_reason_approval_identity_index',
    'schedule_reason_event_resource_index',
  ]);
});

test('persists a skipped event and immutable audit record in one version transition', async () => {
  const { db, transitions, repository } = setup();
  const receipt = await repository.commitReasonEvent({
    event: baseEvent(),
    expectedResourceVersion: 'work-v7',
  });

  assert.deepEqual(transitions, [{
    organizationId: 'org-tenant-a',
    projectId: 'project-alpha',
    workItemId: 'task-17',
    expectedResourceVersion: 'work-v7',
  }]);
  assert.deepEqual(receipt, {
    committed: true,
    eventId: 'evt-01HZY7R8ABCDE12345',
    auditRecordId: 'audit-record-1',
    resourceVersion: 'work-v8',
  });
  assert.equal(Object.isFrozen(receipt), true);

  const eventRow = db.prepare('SELECT * FROM schedule_reason_events').get();
  assert.equal(eventRow.reason_event_type, 'skipped');
  assert.equal(eventRow.prior_resource_version, 'work-v7');
  assert.equal(eventRow.committed_resource_version, 'work-v8');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_event_approval_records').get().count, 0);
  const auditRow = db.prepare('SELECT * FROM schedule_reason_event_audit_records').get();
  assert.equal(auditRow.event_id, eventRow.event_id);
  assert.equal(auditRow.action_type, 'schedule_reason.recorded');
});

test('persists verified cancellation approval evidence without denormalized approval objects', async () => {
  const { db, repository } = setup();
  await repository.commitReasonEvent({
    event: baseEvent({
      type: 'cancelled',
      reasonCode: 'scope_removed',
      approval: {
        approvalId: 'approval-42',
        approverId: 'user-manager-3',
        authorizationId: 'authz-approval-8',
      },
    }),
    expectedResourceVersion: 'work-v7',
  });
  const row = db.prepare(`
    SELECT approval_id, approver_id, approval_authorization_id
      FROM schedule_reason_event_approval_records
  `).get();
  assert.equal(row.approval_id, 'approval-42');
  assert.equal(row.approver_id, 'user-manager-3');
  assert.equal(row.approval_authorization_id, 'authz-approval-8');
});

test('rolls back the version transition and both durable relations when audit persistence fails', async () => {
  const db = newDatabase();
  db.exec(`CREATE TABLE work_item_versions(
    work_item_id TEXT PRIMARY KEY,
    resource_version TEXT NOT NULL
  ); INSERT INTO work_item_versions VALUES('task-17', 'work-v7');`);
  installScheduleReasonEventSchema(db);
  const repository = createSqliteScheduleReasonEventRepository(db, {
    advanceResourceVersion: ({ workItemId, expectedResourceVersion }) => {
      const result = db.prepare(`
        UPDATE work_item_versions SET resource_version = 'work-v8'
         WHERE work_item_id = ? AND resource_version = ?
      `).run(workItemId, expectedResourceVersion);
      return Number(result.changes) === 1
        ? { advanced: true, resourceVersion: 'work-v8' }
        : { advanced: false };
    },
    nextAuditRecordId: () => 'audit-record-fixed',
  });
  await repository.commitReasonEvent({ event: baseEvent(), expectedResourceVersion: 'work-v7' });

  db.exec(`UPDATE work_item_versions SET resource_version = 'work-v7' WHERE work_item_id = 'task-17'`);
  await assert.rejects(
    repository.commitReasonEvent({
      event: baseEvent({ eventId: 'evt-SECOND-ABCDEFG123' }),
      expectedResourceVersion: 'work-v7',
    }),
    /UNIQUE constraint failed: schedule_reason_event_audit_records.audit_record_id/,
  );
  assert.equal(db.prepare(`SELECT resource_version FROM work_item_versions WHERE work_item_id = 'task-17'`).get().resource_version, 'work-v7');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_events').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_event_approval_records').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_event_audit_records').get().count, 1);
});

test('rollback cleanup preserves the causal audit failure and never releases an unconfirmed savepoint', async () => {
  const database = newDatabase();
  database.exec(`CREATE TABLE work_item_versions(
    work_item_id TEXT PRIMARY KEY,
    resource_version TEXT NOT NULL
  ); INSERT INTO work_item_versions VALUES('task-17', 'work-v7');`);
  installScheduleReasonEventSchema(database);
  database.exec(`
    CREATE TRIGGER schedule_reason_test_audit_failure
    BEFORE INSERT ON schedule_reason_event_audit_records
    BEGIN
      SELECT RAISE(ABORT, 'causal schedule audit write failure');
    END;
  `);

  const executed = [];
  const guardedDatabase = {
    prepare: database.prepare.bind(database),
    exec(sql) {
      executed.push(sql);
      if (sql === 'ROLLBACK TO schedule_reason_event_commit_state') {
        throw new Error('simulated rollback cleanup failure');
      }
      return database.exec(sql);
    },
  };
  const repository = createSqliteScheduleReasonEventRepository(guardedDatabase, {
    advanceResourceVersion: ({ workItemId, expectedResourceVersion }) => {
      const result = database.prepare(`
        UPDATE work_item_versions SET resource_version = 'work-v8'
         WHERE work_item_id = ? AND resource_version = ?
      `).run(workItemId, expectedResourceVersion);
      return Number(result.changes) === 1
        ? { advanced: true, resourceVersion: 'work-v8' }
        : { advanced: false };
    },
    nextAuditRecordId: () => 'audit-record-causal',
  });

  await assert.rejects(
    repository.commitReasonEvent({ event: baseEvent(), expectedResourceVersion: 'work-v7' }),
    /causal schedule audit write failure/,
  );
  assert.equal(
    executed.filter((sql) => sql === 'RELEASE schedule_reason_event_commit_state').length,
    0,
    'failed rollback must not release an unconfirmed savepoint',
  );
});

test('fails closed on stale or non-advancing resource versions before durable inserts', async () => {
  for (const transition of [
    { advanced: false },
    { advanced: true, resourceVersion: '' },
    { advanced: true, resourceVersion: 'work-v7' },
  ]) {
    const { db, repository } = setup({ advanceResourceVersion: () => transition });
    await assert.rejects(
      repository.commitReasonEvent({ event: baseEvent(), expectedResourceVersion: 'work-v7' }),
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_events').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_event_approval_records').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_event_audit_records').get().count, 0);
  }
});

test('rejects malformed repository inputs and approval confusion before version mutation', async () => {
  const invalidEvents = [
    null,
    baseEvent({ type: 'blocked' }),
    baseEvent({ eventId: '' }),
    baseEvent({ contractVersion: '' }),
    baseEvent({ organizationId: '' }),
    baseEvent({ projectId: '' }),
    baseEvent({ workItemId: '' }),
    baseEvent({ expectedWorkItemVersion: '' }),
    baseEvent({ reasonCode: '' }),
    baseEvent({ actorId: '' }),
    baseEvent({ occurredAt: '' }),
    baseEvent({ observedAt: '' }),
    baseEvent({ authorizationId: '' }),
    baseEvent({ approval: { approvalId: 'unexpected' } }),
    baseEvent({ type: 'cancelled', approval: null }),
    baseEvent({ type: 'cancelled', approval: { approvalId: '', approverId: 'manager', authorizationId: 'authz' } }),
    baseEvent({ type: 'cancelled', approval: { approvalId: 'approval', approverId: '', authorizationId: 'authz' } }),
    baseEvent({ type: 'cancelled', approval: { approvalId: 'approval', approverId: 'manager', authorizationId: '' } }),
  ];
  for (const event of invalidEvents) {
    const { transitions, repository } = setup();
    await assert.rejects(repository.commitReasonEvent({ event, expectedResourceVersion: 'work-v7' }));
    assert.deepEqual(transitions, []);
  }

  const { transitions, repository } = setup();
  await assert.rejects(repository.commitReasonEvent(null));
  await assert.rejects(repository.commitReasonEvent({ event: baseEvent(), expectedResourceVersion: '' }));
  await assert.rejects(repository.commitReasonEvent({ event: baseEvent(), expectedResourceVersion: 'work-v6' }));
  assert.deepEqual(transitions, []);
});

test('validates constructor dependencies and generated audit evidence', async () => {
  const db = newDatabase();
  assert.throws(() => installScheduleReasonEventSchema(null));
  assert.throws(() => createSqliteScheduleReasonEventRepository(null, {}));
  installScheduleReasonEventSchema(db);
  for (const dependencies of [null, {}, { advanceResourceVersion() {} }]) {
    assert.throws(() => createSqliteScheduleReasonEventRepository(db, dependencies));
  }
  const repository = createSqliteScheduleReasonEventRepository(db, {
    advanceResourceVersion: () => ({ advanced: true, resourceVersion: 'work-v8' }),
    nextAuditRecordId: () => '',
  });
  await assert.rejects(
    repository.commitReasonEvent({ event: baseEvent(), expectedResourceVersion: 'work-v7' }),
    /generated auditRecordId/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_events').get().count, 0);
});