import assert from 'node:assert/strict';
import {
  CALENDAR_SUBSCRIPTION_AUDIENCE,
  CALENDAR_SUBSCRIPTION_MAX_LIFETIME_MS,
  CALENDAR_SUBSCRIPTION_PURPOSE,
  CalendarSubscriptionError,
  createCalendarSubscriptionService,
} from '../../server/calendar_subscription_domain.mjs';

const NOW = 1_900_000_000_000;
const VALID_SECRET = Buffer.alloc(32, 7).toString('base64url');

function ports(overrides = {}) {
  const repository = {
    insertSubscription: async () => {},
    listSubscriptions: async () => [],
    findSubscriptionByHash: async () => null,
    recordUsageAtomically: async () => null,
    rotateSubscriptionAtomically: async () => null,
    revokeSubscriptionAtomically: async () => null,
    ...(overrides.repository || {}),
  };
  return {
    repository,
    clock: overrides.clock || { nowMs: () => NOW },
    randomSource: overrides.randomSource || { randomBytes: (size) => new Uint8Array(size).fill(9) },
    auditSink: overrides.auditSink || { record: async () => {} },
    projectAuthorization: overrides.projectAuthorization || { assertCanManage: async () => {} },
    membershipRevocation: overrides.membershipRevocation || { assertActive: async () => 'membership-v1' },
  };
}

function service(overrides = {}) {
  return createCalendarSubscriptionService(ports(overrides));
}

async function expectError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CalendarSubscriptionError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

{
  const valid = ports();
  const requirements = [
    ['repository', 'insertSubscription'],
    ['repository', 'listSubscriptions'],
    ['repository', 'findSubscriptionByHash'],
    ['repository', 'recordUsageAtomically'],
    ['repository', 'rotateSubscriptionAtomically'],
    ['repository', 'revokeSubscriptionAtomically'],
    ['clock', 'nowMs'],
    ['randomSource', 'randomBytes'],
    ['auditSink', 'record'],
    ['projectAuthorization', 'assertCanManage'],
    ['membershipRevocation', 'assertActive'],
  ];
  for (const [portName, method] of requirements) {
    const broken = ports();
    broken[portName] = { ...broken[portName] };
    delete broken[portName][method];
    assert.throws(
      () => createCalendarSubscriptionService(broken),
      new RegExp(`calendar-subscription dependency must provide ${method}\\(\\)`),
    );
  }
  assert.ok(createCalendarSubscriptionService(valid));
  assert.throws(() => createCalendarSubscriptionService(), /insertSubscription/);
}

{
  const svc = service();
  const invalidIdentities = [
    { subjectId: '', projectId: 'project-1' },
    { subjectId: ' user-1', projectId: 'project-1' },
    { subjectId: 'user\n1', projectId: 'project-1' },
    { subjectId: 'user-1', projectId: '' },
    { subjectId: 'user-1', projectId: ' project-1' },
    { subjectId: 1, projectId: 'project-1' },
  ];
  for (const identity of invalidIdentities) {
    await expectError(
      svc.create({ ...identity, name: 'Calendar', expiresAtMs: NOW + 10 }),
      'calendar_subscription_request_invalid', 400,
    );
  }
  for (const name of ['', ' Calendar', 'Calendar\u0000', 'x'.repeat(121), null]) {
    await expectError(
      svc.create({ subjectId: 'user-1', projectId: 'project-1', name, expiresAtMs: NOW + 10 }),
      'calendar_subscription_request_invalid', 400,
    );
  }
  for (const expiresAtMs of [
    NOW,
    NOW - 1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    NOW + CALENDAR_SUBSCRIPTION_MAX_LIFETIME_MS + 1,
  ]) {
    await expectError(
      svc.create({ subjectId: 'user-1', projectId: 'project-1', name: 'Calendar', expiresAtMs }),
      'calendar_subscription_expiry_invalid', 400,
    );
  }
}

{
  for (const version of [0, 4, 'v4']) {
    const svc = service({ membershipRevocation: { assertActive: async () => version } });
    const created = await svc.create({ subjectId: 'user-1', projectId: 'project-1', name: 'Calendar', expiresAtMs: NOW + 10 });
    assert.equal(created.status, 'active');
  }
  for (const version of [-1, Number.NaN, '', ' v1', 'v1\u0000', 'x'.repeat(129), {}, null]) {
    const svc = service({ membershipRevocation: { assertActive: async () => version } });
    await expectError(
      svc.create({ subjectId: 'user-1', projectId: 'project-1', name: 'Calendar', expiresAtMs: NOW + 10 }),
      'calendar_subscription_unauthorized', 401,
    );
  }
  const revoked = service({ membershipRevocation: { assertActive: async () => { throw new Error('revoked'); } } });
  await expectError(
    revoked.create({ subjectId: 'user-1', projectId: 'project-1', name: 'Calendar', expiresAtMs: NOW + 10 }),
    'calendar_subscription_unauthorized', 401,
  );
}

{
  const denied = service({ projectAuthorization: { assertCanManage: async () => { throw new Error('no'); } } });
  await expectError(
    denied.create({ subjectId: 'user-1', projectId: 'project-1', name: 'Calendar', expiresAtMs: NOW + 10 }),
    'calendar_subscription_not_found', 404,
  );
  await expectError(denied.list({ subjectId: 'user-1', projectId: 'project-1' }), 'calendar_subscription_not_found', 404);
}

{
  const badClock = service({ clock: { nowMs: () => -1 } });
  await assert.rejects(
    badClock.create({ subjectId: 'user-1', projectId: 'project-1', name: 'Calendar', expiresAtMs: NOW + 10 }),
    /clock must return a non-negative safe integer/,
  );
  const fractionalClock = service({ clock: { nowMs: () => 1.5 } });
  await assert.rejects(fractionalClock.list({ subjectId: 'user-1', projectId: 'project-1' }), /clock must return/);
}

{
  const badSecretBytes = service({ randomSource: { randomBytes: () => new Uint8Array(31) } });
  await assert.rejects(
    badSecretBytes.create({ subjectId: 'user-1', projectId: 'project-1', name: 'Calendar', expiresAtMs: NOW + 10 }),
    /must return 32 bytes/,
  );
  let call = 0;
  const badIdBytes = service({ randomSource: { randomBytes: (size) => { call += 1; return new Uint8Array(call === 1 ? size : 15); } } });
  await assert.rejects(
    badIdBytes.create({ subjectId: 'user-1', projectId: 'project-1', name: 'Calendar', expiresAtMs: NOW + 10 }),
    /must return 16 bytes for subscription id/,
  );
  const notBytes = service({ randomSource: { randomBytes: () => 'not-bytes' } });
  await assert.rejects(
    notBytes.create({ subjectId: 'user-1', projectId: 'project-1', name: 'Calendar', expiresAtMs: NOW + 10 }),
    /must return 32 bytes/,
  );
}

{
  const nonArray = service({ repository: { listSubscriptions: async () => ({}) } });
  await assert.rejects(nonArray.list({ subjectId: 'user-1', projectId: 'project-1' }), /must return an array/);

  const expiredRow = {
    subscription_id: 'csub_expired', subject_id: 'user-1', project_id: 'project-1', name: 'Old',
    audience: CALENDAR_SUBSCRIPTION_AUDIENCE, created_at_ms: NOW - 100, expires_at_ms: NOW,
    last_used_at_ms: NOW - 10, rotated_at_ms: NOW - 20, revoked_at_ms: null,
  };
  const revokedRow = { ...expiredRow, subscription_id: 'csub_revoked', revoked_at_ms: NOW - 1 };
  const listed = await service({ repository: { listSubscriptions: async () => [expiredRow, revokedRow] } })
    .list({ subjectId: 'user-1', projectId: 'project-1' });
  assert.deepEqual(listed.map((row) => row.status), ['expired', 'revoked']);
  assert.equal(listed[0].lastUsedAtMs, NOW - 10);
  assert.equal(listed[0].rotatedAtMs, NOW - 20);
}

{
  const svc = service();
  for (const candidate of [null, '', 'short', `${VALID_SECRET}=`, VALID_SECRET]) {
    const projectId = candidate === VALID_SECRET ? '' : 'project-1';
    await expectError(svc.authorize({ secret: candidate, projectId }), 'calendar_subscription_unauthorized', 401);
  }

  const baseRecord = {
    subscription_id: 'csub_123', subject_id: 'user-1', project_id: 'project-1', name: 'Calendar',
    purpose: CALENDAR_SUBSCRIPTION_PURPOSE, audience: CALENDAR_SUBSCRIPTION_AUDIENCE,
    membership_version: 'membership-v1', created_at_ms: NOW - 1, expires_at_ms: NOW + 100,
    last_used_at_ms: null, rotated_at_ms: null, revoked_at_ms: null,
  };
  for (const record of [
    null,
    { ...baseRecord, project_id: 'project-2' },
    { ...baseRecord, audience: 'other' },
    { ...baseRecord, purpose: 'stream' },
  ]) {
    const candidate = service({ repository: { findSubscriptionByHash: async () => record } });
    await expectError(candidate.authorize({ secret: VALID_SECRET, projectId: 'project-1' }), 'calendar_subscription_unauthorized', 401);
  }
  const atomicReject = service({ repository: {
    findSubscriptionByHash: async () => baseRecord,
    recordUsageAtomically: async () => null,
  } });
  await expectError(atomicReject.authorize({ secret: VALID_SECRET, projectId: 'project-1' }), 'calendar_subscription_unauthorized', 401);

  const membershipReject = service({
    repository: { findSubscriptionByHash: async () => baseRecord },
    membershipRevocation: { assertActive: async () => { throw new Error('gone'); } },
  });
  await expectError(membershipReject.authorize({ secret: VALID_SECRET, projectId: 'project-1' }), 'calendar_subscription_unauthorized', 401);

  const exactExpiry = service({
    repository: { findSubscriptionByHash: async () => ({ ...baseRecord, expires_at_ms: NOW }) },
  });
  await expectError(exactExpiry.authorize({ secret: VALID_SECRET, projectId: 'project-1' }), 'calendar_subscription_unauthorized', 401);

  let authorizeLiveVersion = 'membership-v1';
  const authorizeMidCheck = service({
    repository: {
      findSubscriptionByHash: async () => ({ ...baseRecord, membership_version: 'membership-v1' }),
      recordUsageAtomically: async (_hash, expected) => (
        authorizeLiveVersion === expected.membership_version ? { ...baseRecord, last_used_at_ms: NOW } : null
      ),
    },
    membershipRevocation: {
      async assertActive() {
        const captured = authorizeLiveVersion;
        authorizeLiveVersion = 'membership-v2';
        return captured;
      },
    },
  });
  await expectError(
    authorizeMidCheck.authorize({ secret: VALID_SECRET, projectId: 'project-1' }),
    'calendar_subscription_unauthorized',
    401,
  );

  let rotateLiveVersion = 'membership-v1';
  const rotateMidCheck = service({
    repository: {
      rotateSubscriptionAtomically: async (_id, expected) => (
        rotateLiveVersion === expected.membership_version
          ? { ...baseRecord, secret_hash: 'rotated', rotated_at_ms: NOW, membership_version: expected.membership_version }
          : null
      ),
    },
    membershipRevocation: {
      async assertActive() {
        const captured = rotateLiveVersion;
        rotateLiveVersion = 'membership-v2';
        return captured;
      },
    },
  });
  await expectError(
    rotateMidCheck.rotate({
      subjectId: 'user-1', projectId: 'project-1', subscriptionId: 'csub_123', expiresAtMs: NOW + 10,
    }),
    'calendar_subscription_not_found',
    404,
  );
}

{
  const svc = service();
  for (const input of [
    { subjectId: '', projectId: 'project-1', subscriptionId: 'csub_1', expiresAtMs: NOW + 10 },
    { subjectId: 'user-1', projectId: 'project-1', subscriptionId: '', expiresAtMs: NOW + 10 },
  ]) {
    await expectError(svc.rotate(input), 'calendar_subscription_request_invalid', 400);
  }
  await expectError(
    svc.rotate({ subjectId: 'user-1', projectId: 'project-1', subscriptionId: 'csub_1', expiresAtMs: NOW }),
    'calendar_subscription_expiry_invalid', 400,
  );
  await expectError(
    svc.rotate({ subjectId: 'user-1', projectId: 'project-1', subscriptionId: 'csub_missing', expiresAtMs: NOW + 10 }),
    'calendar_subscription_not_found', 404,
  );
  await expectError(
    svc.revoke({ subjectId: 'user-1', projectId: 'project-1', subscriptionId: 'csub_missing' }),
    'calendar_subscription_not_found', 404,
  );
  await expectError(
    svc.revoke({ subjectId: 'user-1', projectId: 'project-1', subscriptionId: '' }),
    'calendar_subscription_request_invalid', 400,
  );
}

console.log('calendar subscription domain edge tests passed');
