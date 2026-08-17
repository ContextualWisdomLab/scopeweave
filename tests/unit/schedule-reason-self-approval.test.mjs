import assert from 'node:assert/strict';
import test from 'node:test';

import { recordScheduleReasonEvent } from '../../server/schedule_reason_event_domain.mjs';

test('cancellation cannot be approved by the actor performing the cancellation', async () => {
  let commitCalled = false;
  const actorId = 'user-owner-9';
  const ports = {
    clock: { now: () => '2026-08-17T13:00:00.000Z' },
    randomSource: { nextOpaqueId: () => 'evt-01HZY7R8ABCDE12345' },
    authorizationPort: {
      authorize: async () => ({
        allowed: true,
        authorizationId: 'authz-decision-22',
        resourceVersion: 'work-v7',
      }),
    },
    approvalPort: {
      verifyCancellationApproval: async () => ({
        valid: true,
        approvalId: 'approval-42',
        approverId: actorId,
        authorizationId: 'authz-approval-8',
        resourceVersion: 'work-v7',
      }),
    },
    repositoryPort: {
      commitReasonEvent: async () => {
        commitCalled = true;
        throw new Error('persistence must not be reached for self approval');
      },
    },
  };

  await assert.rejects(
    recordScheduleReasonEvent({
      organizationId: 'org-tenant-a',
      projectId: 'project-alpha',
      workItemId: 'task-17',
      actorId,
      expectedWorkItemVersion: 'work-v7',
      type: 'cancelled',
      reasonCode: 'scope_removed',
      occurredAt: '2026-08-17T12:00:00.000Z',
      approvalRef: 'approval-request-42',
    }, ports),
    /cancellation approver must be distinct from the acting user/,
  );
  assert.equal(commitCalled, false);
});
