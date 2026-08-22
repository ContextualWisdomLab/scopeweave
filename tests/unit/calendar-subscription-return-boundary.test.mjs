import assert from 'node:assert/strict';
import {
  CALENDAR_SUBSCRIPTION_AUDIENCE,
  CALENDAR_SUBSCRIPTION_PURPOSE,
  CalendarSubscriptionError,
  createCalendarSubscriptionService,
} from '../../server/calendar_subscription_domain.mjs';

const NOW = 1_900_000_000_000;
const ROTATE_EXPIRY = NOW + 10;
const VALID_SECRET = Buffer.alloc(32, 7).toString('base64url');

const baseRecord = {
  subscription_id: 'csub_123',
  subject_id: 'user-1',
  project_id: 'project-1',
  name: 'Calendar',
  purpose: CALENDAR_SUBSCRIPTION_PURPOSE,
  audience: CALENDAR_SUBSCRIPTION_AUDIENCE,
  membership_version: 'membership-v1',
  created_at_ms: NOW - 1,
  expires_at_ms: NOW + 100,
  last_used_at_ms: null,
  rotated_at_ms: null,
  revoked_at_ms: null,
};

function service(repositoryOverrides) {
  return createCalendarSubscriptionService({
    repository: {
      insertSubscription: async () => {},
      listSubscriptions: async () => [],
      findSubscriptionByHash: async () => baseRecord,
      recordUsageAtomically: async () => null,
      rotateSubscriptionAtomically: async () => null,
      revokeSubscriptionAtomically: async () => null,
      ...repositoryOverrides,
    },
    clock: { nowMs: () => NOW },
    randomSource: { randomBytes: (size) => new Uint8Array(size).fill(9) },
    auditSink: { record: async () => {} },
    projectAuthorization: { assertCanManage: async () => {} },
    membershipRevocation: { assertActive: async () => 'membership-v1' },
  });
}

async function expectDomainError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CalendarSubscriptionError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

for (const returned of [
  { ...baseRecord, subscription_id: 'csub_other', last_used_at_ms: NOW },
  { ...baseRecord, subject_id: 'user-2', last_used_at_ms: NOW },
  { ...baseRecord, project_id: 'project-2', last_used_at_ms: NOW },
  { ...baseRecord, purpose: 'session', last_used_at_ms: NOW },
  { ...baseRecord, audience: 'scopeweave:other', last_used_at_ms: NOW },
  { ...baseRecord, membership_version: 'membership-v2', last_used_at_ms: NOW },
]) {
  const candidate = service({ recordUsageAtomically: async () => returned });
  await expectDomainError(
    candidate.authorize({ secret: VALID_SECRET, projectId: 'project-1' }),
    'calendar_subscription_unauthorized',
    401,
  );
}

const rotatedRecord = {
  ...baseRecord,
  expires_at_ms: ROTATE_EXPIRY,
  rotated_at_ms: NOW,
};

for (const returned of [
  { ...rotatedRecord, subscription_id: 'csub_other' },
  { ...rotatedRecord, subject_id: 'user-2' },
  { ...rotatedRecord, project_id: 'project-2' },
  { ...rotatedRecord, purpose: 'session' },
  { ...rotatedRecord, audience: 'scopeweave:other' },
  { ...rotatedRecord, membership_version: 'membership-v2' },
  { ...rotatedRecord, expires_at_ms: ROTATE_EXPIRY + 1 },
]) {
  const candidate = service({ rotateSubscriptionAtomically: async () => returned });
  await expectDomainError(
    candidate.rotate({
      subjectId: 'user-1',
      projectId: 'project-1',
      subscriptionId: 'csub_123',
      expiresAtMs: ROTATE_EXPIRY,
    }),
    'calendar_subscription_not_found',
    404,
  );
}

for (const returned of [
  null,
  'not-a-record',
  [],
  { ...baseRecord, subject_id: 'user-2' },
  { ...baseRecord, project_id: 'project-2' },
  { ...baseRecord, purpose: 'session' },
  { ...baseRecord, audience: 'scopeweave:other' },
]) {
  const candidate = service({ listSubscriptions: async () => [returned] });
  await expectDomainError(
    candidate.list({ subjectId: 'user-1', projectId: 'project-1' }),
    'calendar_subscription_not_found',
    404,
  );
}

console.log('calendar subscription atomic return boundary tests passed');
