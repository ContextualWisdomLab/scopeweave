import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCHEDULE_REASON_EVENT_CONTRACT_VERSION,
  SCHEDULE_REASON_EVENT_TYPES,
  recordScheduleReasonEvent,
} from '../../server/schedule_reason_event_domain.mjs';

const baseInput = (overrides = {}) => ({
  organizationId: 'org-tenant-a',
  projectId: 'project-alpha',
  workItemId: 'task-17',
  actorId: 'user-owner-9',
  expectedWorkItemVersion: 'work-v7',
  type: 'skipped',
  reasonCode: 'duplicate_scope',
  occurredAt: '2026-08-15T22:00:00.000Z',
  approvalRef: null,
  ...overrides,
});

const makePorts = (overrides = {}) => {
  const calls = [];
  const ports = {
    clock: {
      now: () => '2026-08-15T23:00:00.000Z',
    },
    randomSource: {
      nextOpaqueId: () => 'evt-01HZY7R8ABCDE12345',
    },
    authorizationPort: {
      authorize: async (request) => {
        calls.push(['authorize', request]);
        return {
          allowed: true,
          authorizationId: 'authz-decision-22',
          resourceVersion: 'work-v7',
        };
      },
    },
    approvalPort: {
      verifyCancellationApproval: async (request) => {
        calls.push(['approval', request]);
        return {
          valid: true,
          approvalId: 'approval-42',
          approverId: 'user-manager-3',
          authorizationId: 'authz-approval-8',
          resourceVersion: 'work-v7',
        };
      },
    },
    repositoryPort: {
      commitReasonEvent: async (request) => {
        calls.push(['commit', request]);
        return {
          committed: true,
          eventId: request.event.eventId,
          auditRecordId: 'audit-record-77',
          resourceVersion: 'work-v8',
        };
      },
    },
    ...overrides,
  };
  return { ports, calls };
};

test('exports a frozen explicit reason vocabulary and versioned contract', () => {
  assert.deepEqual(SCHEDULE_REASON_EVENT_TYPES, ['skipped', 'cancelled', 'not_performed']);
  assert.equal(Object.isFrozen(SCHEDULE_REASON_EVENT_TYPES), true);
  assert.equal(SCHEDULE_REASON_EVENT_CONTRACT_VERSION, 'schedule-reason-event/v1');
});

test('authorizes, commits, and freezes one skipped reason event without invoking approval verification', async () => {
  const { ports, calls } = makePorts();
  const result = await recordScheduleReasonEvent(baseInput(), ports);

  assert.deepEqual(calls.map(([kind]) => kind), ['authorize', 'commit']);
  assert.deepEqual(calls[0][1], {
    organizationId: 'org-tenant-a',
    projectId: 'project-alpha',
    workItemId: 'task-17',
    actorId: 'user-owner-9',
    action: 'schedule_outcome.skip',
    expectedResourceVersion: 'work-v7',
  });
  assert.equal(calls[1][1].expectedResourceVersion, 'work-v7');
  assert.equal(calls[1][1].event.authorizationId, 'authz-decision-22');
  assert.equal(calls[1][1].event.approval, null);
  assert.equal(result.event.type, 'skipped');
  assert.equal(result.event.contractVersion, 'schedule-reason-event/v1');
  assert.equal(result.receipt.auditRecordId, 'audit-record-77');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.event), true);
  assert.equal(Object.isFrozen(result.receipt), true);
});

test('maps not_performed to its own authorization action', async () => {
  const { ports, calls } = makePorts();
  await recordScheduleReasonEvent(baseInput({
    type: 'not_performed',
    reasonCode: 'vendor_unavailable',
    occurredAt: '2026-08-15T21:00:00.000Z',
  }), ports);

  assert.equal(calls[0][1].action, 'schedule_outcome.not_performed');
  assert.deepEqual(calls.map(([kind]) => kind), ['authorize', 'commit']);
});

test('requires verified cancellation approval bound to the same tenant, work item, and version', async () => {
  const { ports, calls } = makePorts();
  const result = await recordScheduleReasonEvent(baseInput({
    type: 'cancelled',
    reasonCode: 'scope_removed',
    approvalRef: 'approval-request-42',
  }), ports);

  assert.deepEqual(calls.map(([kind]) => kind), ['authorize', 'approval', 'commit']);
  assert.equal(calls[0][1].action, 'schedule_outcome.cancel');
  assert.deepEqual(calls[1][1], {
    organizationId: 'org-tenant-a',
    projectId: 'project-alpha',
    workItemId: 'task-17',
    actorId: 'user-owner-9',
    approvalRef: 'approval-request-42',
    expectedResourceVersion: 'work-v7',
  });
  assert.deepEqual(result.event.approval, {
    approvalId: 'approval-42',
    approverId: 'user-manager-3',
    authorizationId: 'authz-approval-8',
  });
  assert.equal(Object.isFrozen(result.event.approval), true);
});

test('fails closed on denied action authorization before approval or persistence', async () => {
  const { ports, calls } = makePorts({
    authorizationPort: {
      authorize: async (request) => {
        calls.push(['authorize', request]);
        return { allowed: false };
      },
    },
  });

  await assert.rejects(
    recordScheduleReasonEvent(baseInput(), ports),
    /schedule reason event authorization denied/,
  );
  assert.deepEqual(calls.map(([kind]) => kind), ['authorize']);
});

test('fails closed when authorization was evaluated against a stale work-item version', async () => {
  const { ports, calls } = makePorts({
    authorizationPort: {
      authorize: async (request) => {
        calls.push(['authorize', request]);
        return {
          allowed: true,
          authorizationId: 'authz-decision-22',
          resourceVersion: 'work-v6',
        };
      },
    },
  });

  await assert.rejects(
    recordScheduleReasonEvent(baseInput(), ports),
    /authorization resource version is stale/,
  );
  assert.deepEqual(calls.map(([kind]) => kind), ['authorize']);
});

test('fails closed on invalid or stale cancellation approval before persistence', async () => {
  for (const approval of [
    { valid: false },
    {
      valid: true,
      approvalId: 'approval-42',
      approverId: 'user-manager-3',
      authorizationId: 'authz-approval-8',
      resourceVersion: 'work-v6',
    },
  ]) {
    const { ports, calls } = makePorts({
      approvalPort: {
        verifyCancellationApproval: async (request) => {
          calls.push(['approval', request]);
          return approval;
        },
      },
    });

    await assert.rejects(
      recordScheduleReasonEvent(baseInput({
        type: 'cancelled',
        reasonCode: 'scope_removed',
        approvalRef: 'approval-request-42',
      }), ports),
      approval.valid ? /approval resource version is stale/ : /cancellation approval denied/,
    );
    assert.deepEqual(calls.map(([kind]) => kind), ['authorize', 'approval']);
  }
});

test('rejects approval references for non-cancellation events to prevent authority confusion', async () => {
  const { ports, calls } = makePorts();

  await assert.rejects(
    recordScheduleReasonEvent(baseInput({ approvalRef: 'approval-request-42' }), ports),
    /approvalRef is only valid for cancelled events/,
  );
  assert.deepEqual(calls, []);
});

test('requires a cancellation approval reference before any authorization side effect', async () => {
  const { ports, calls } = makePorts();

  await assert.rejects(
    recordScheduleReasonEvent(baseInput({ type: 'cancelled', reasonCode: 'scope_removed' }), ports),
    /cancelled events require approvalRef/,
  );
  assert.deepEqual(calls, []);
});

test('requires a trustworthy authorization snapshot and commit receipt', async () => {
  for (const authorization of [
    null,
    { allowed: true, authorizationId: '', resourceVersion: 'work-v7' },
    { allowed: true, authorizationId: 'authz-decision-22', resourceVersion: '' },
  ]) {
    const { ports } = makePorts({
      authorizationPort: { authorize: async () => authorization },
    });
    await assert.rejects(recordScheduleReasonEvent(baseInput(), ports));
  }

  for (const receipt of [
    null,
    { committed: false },
    { committed: true, eventId: 'different-event', auditRecordId: 'audit-record-77', resourceVersion: 'work-v8' },
    { committed: true, eventId: 'evt-01HZY7R8ABCDE12345', auditRecordId: '', resourceVersion: 'work-v8' },
    { committed: true, eventId: 'evt-01HZY7R8ABCDE12345', auditRecordId: 'audit-record-77', resourceVersion: '' },
  ]) {
    const { ports } = makePorts({
      repositoryPort: { commitReasonEvent: async () => receipt },
    });
    await assert.rejects(recordScheduleReasonEvent(baseInput(), ports));
  }
});

test('rejects malformed trusted approval snapshots', async () => {
  const invalidApprovals = [
    { valid: true, approvalId: '', approverId: 'user-manager-3', authorizationId: 'authz-approval-8', resourceVersion: 'work-v7' },
    { valid: true, approvalId: 'approval-42', approverId: '', authorizationId: 'authz-approval-8', resourceVersion: 'work-v7' },
    { valid: true, approvalId: 'approval-42', approverId: 'user-manager-3', authorizationId: '', resourceVersion: 'work-v7' },
  ];

  for (const approval of invalidApprovals) {
    const { ports } = makePorts({
      approvalPort: { verifyCancellationApproval: async () => approval },
    });
    await assert.rejects(recordScheduleReasonEvent(baseInput({
      type: 'cancelled',
      reasonCode: 'scope_removed',
      approvalRef: 'approval-request-42',
    }), ports));
  }
});

test('validates input, canonical timestamps, opaque generated IDs, and port contracts before mutation', async () => {
  const invalidInputs = [
    null,
    [],
    baseInput({ organizationId: '' }),
    baseInput({ projectId: 'bad\nproject' }),
    baseInput({ workItemId: '' }),
    baseInput({ actorId: '' }),
    baseInput({ expectedWorkItemVersion: '' }),
    baseInput({ type: 'blocked' }),
    baseInput({ reasonCode: '' }),
    baseInput({ occurredAt: '2026-08-15 22:00:00Z' }),
    baseInput({ occurredAt: '2026-08-16T00:00:00.000Z' }),
  ];

  for (const input of invalidInputs) {
    const { ports, calls } = makePorts();
    await assert.rejects(recordScheduleReasonEvent(input, ports));
    assert.deepEqual(calls, []);
  }

  for (const badPorts of [
    null,
    {},
    { clock: { now: () => '2026-08-15T23:00:00.000Z' } },
  ]) {
    await assert.rejects(recordScheduleReasonEvent(baseInput(), badPorts));
  }

  for (const badNow of ['not-a-time', '2026-08-15T23:00:00Z']) {
    const { ports, calls } = makePorts({ clock: { now: () => badNow } });
    await assert.rejects(recordScheduleReasonEvent(baseInput(), ports));
    assert.deepEqual(calls, []);
  }

  for (const badId of ['', '12345678', 'bad id']) {
    const { ports, calls } = makePorts({ randomSource: { nextOpaqueId: () => badId } });
    await assert.rejects(recordScheduleReasonEvent(baseInput(), ports));
    assert.deepEqual(calls, []);
  }
});

test('does not retain mutable caller input or mutable port response objects', async () => {
  const input = baseInput();
  const authorization = {
    allowed: true,
    authorizationId: 'authz-decision-22',
    resourceVersion: 'work-v7',
  };
  const { ports } = makePorts({
    authorizationPort: { authorize: async () => authorization },
  });
  const result = await recordScheduleReasonEvent(input, ports);

  input.reasonCode = 'mutated';
  authorization.authorizationId = 'mutated-authz';
  assert.equal(result.event.reasonCode, 'duplicate_scope');
  assert.equal(result.event.authorizationId, 'authz-decision-22');
});
