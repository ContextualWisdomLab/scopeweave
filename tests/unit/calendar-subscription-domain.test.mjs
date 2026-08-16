import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CALENDAR_SUBSCRIPTION_AUDIENCE,
  CALENDAR_SUBSCRIPTION_MAX_LIFETIME_MS,
  CALENDAR_SUBSCRIPTION_PURPOSE,
  CalendarSubscriptionError,
  createCalendarSubscriptionService,
} from '../../server/calendar_subscription_domain.mjs';

function sequentialRandomSource() {
  let seed = 1;
  return {
    randomBytes(size) {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) bytes[index] = (seed + index) % 256;
      seed += size;
      return bytes;
    },
  };
}

function makeHarness({ nowMs = 1_800_000_000_000, auditThrows = false } = {}) {
  const rows = new Map();
  const hashIndex = new Map();
  const rotations = [];
  const usages = [];
  const audits = [];
  const activeMemberships = new Map([['user-1:project-1', 3]]);

  const repository = {
    async insertSubscription(record) {
      rows.set(record.subscription_id, structuredClone(record));
      hashIndex.set(record.secret_hash, record.subscription_id);
    },
    async listSubscriptions({ subject_id, project_id }) {
      return [...rows.values()].filter((row) => row.subject_id === subject_id && row.project_id === project_id);
    },
    async findSubscriptionByHash(secretHash) {
      const id = hashIndex.get(secretHash);
      return id ? structuredClone(rows.get(id)) : null;
    },
    async recordUsageAtomically(secretHash, expected) {
      const id = hashIndex.get(secretHash);
      const row = id ? rows.get(id) : null;
      const liveVersion = activeMemberships.get(`${row?.subject_id}:${row?.project_id}`);
      if (
        !row
        || row.project_id !== expected.project_id
        || row.audience !== expected.audience
        || row.purpose !== expected.purpose
        || row.revoked_at_ms !== null
        || row.expires_at_ms <= expected.now_ms
        || row.membership_version !== expected.membership_version
        || liveVersion !== expected.membership_version
      ) return null;
      row.last_used_at_ms = expected.now_ms;
      usages.push({ subscription_id: row.subscription_id, used_at_ms: expected.now_ms });
      return structuredClone(row);
    },
    async rotateSubscriptionAtomically(subscriptionId, expected) {
      const row = rows.get(subscriptionId);
      const liveVersion = activeMemberships.get(`${row?.subject_id}:${row?.project_id}`);
      if (
        !row
        || row.subject_id !== expected.subject_id
        || row.project_id !== expected.project_id
        || row.purpose !== expected.purpose
        || row.revoked_at_ms !== null
        || row.expires_at_ms <= expected.now_ms
        || liveVersion !== expected.membership_version
      ) return null;
      hashIndex.delete(row.secret_hash);
      rotations.push({
        subscription_id: row.subscription_id,
        previous_secret_hash: row.secret_hash,
        rotated_at_ms: expected.now_ms,
      });
      row.secret_hash = expected.new_secret_hash;
      row.rotated_at_ms = expected.now_ms;
      row.expires_at_ms = expected.expires_at_ms;
      row.membership_version = expected.membership_version;
      hashIndex.set(row.secret_hash, row.subscription_id);
      return structuredClone(row);
    },
    async revokeSubscriptionAtomically(subscriptionId, expected) {
      const row = rows.get(subscriptionId);
      if (!row || row.subject_id !== expected.subject_id || row.project_id !== expected.project_id) return null;
      const revocationApplied = row.revoked_at_ms === null;
      if (revocationApplied) row.revoked_at_ms = expected.now_ms;
      return { ...structuredClone(row), revocation_applied: revocationApplied };
    },
  };

  const projectAuthorization = {
    async assertCanManage({ subjectId, projectId }) {
      if (!activeMemberships.has(`${subjectId}:${projectId}`)) throw new Error('not authorized');
    },
  };
  const membershipRevocation = {
    async assertActive({ subjectId, projectId }) {
      const version = activeMemberships.get(`${subjectId}:${projectId}`);
      if (version === undefined) throw new Error('revoked');
      return version;
    },
  };
  const auditSink = {
    async record(event) {
      if (auditThrows) throw new Error('audit unavailable');
      audits.push(structuredClone(event));
    },
  };
  const clock = { nowMs: () => nowMs };
  const service = createCalendarSubscriptionService({
    repository,
    clock,
    randomSource: sequentialRandomSource(),
    auditSink,
    projectAuthorization,
    membershipRevocation,
  });

  return {
    service,
    repository,
    rows,
    hashIndex,
    rotations,
    usages,
    audits,
    activeMemberships,
    setNow(value) { nowMs = value; },
  };
}

async function expectDomainError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CalendarSubscriptionError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

{
  const h = makeHarness();
  const created = await h.service.create({
    subjectId: 'user-1',
    projectId: 'project-1',
    name: 'Executive calendar',
    expiresAtMs: 1_800_086_400_000,
  });
  assert.equal(CALENDAR_SUBSCRIPTION_AUDIENCE, 'scopeweave:calendar');
  assert.match(created.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.subscriptionId, /^csub_[a-f0-9]{32}$/);
  assert.equal(created.name, 'Executive calendar');
  assert.equal(created.projectId, 'project-1');
  assert.equal(created.subjectId, 'user-1');
  assert.equal(created.purpose, CALENDAR_SUBSCRIPTION_PURPOSE);
  assert.equal(created.audience, CALENDAR_SUBSCRIPTION_AUDIENCE);
  assert.equal(created.createdAtMs, 1_800_000_000_000);
  assert.equal(created.expiresAtMs, 1_800_086_400_000);
  assert.equal(created.lastUsedAtMs, null);
  assert.equal(created.rotatedAtMs, null);
  assert.equal(created.revokedAtMs, null);
  assert.equal(created.status, 'active');
  assert.equal(Object.isFrozen(created), true);

  const stored = h.rows.get(created.subscriptionId);
  assert.equal(stored.secret_hash, createHash('sha256').update(created.secret).digest('hex'));
  assert.equal(stored.membership_version, 3);
  assert.equal(JSON.stringify(stored).includes(created.secret), false);
  assert.equal(JSON.stringify(h.audits).includes(created.secret), false);
  assert.equal(JSON.stringify(h.audits).includes(stored.secret_hash), false);
  assert.deepEqual(h.audits[0], {
    event: 'calendar_subscription.created',
    subscription_id: created.subscriptionId,
    subject_id: 'user-1',
    project_id: 'project-1',
    purpose: CALENDAR_SUBSCRIPTION_PURPOSE,
    audience: CALENDAR_SUBSCRIPTION_AUDIENCE,
    expires_at_ms: 1_800_086_400_000,
  });

  const listed = await h.service.list({ subjectId: 'user-1', projectId: 'project-1' });
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], {
    subscriptionId: created.subscriptionId,
    subjectId: 'user-1',
    projectId: 'project-1',
    name: 'Executive calendar',
    purpose: CALENDAR_SUBSCRIPTION_PURPOSE,
    audience: CALENDAR_SUBSCRIPTION_AUDIENCE,
    createdAtMs: 1_800_000_000_000,
    expiresAtMs: 1_800_086_400_000,
    lastUsedAtMs: null,
    rotatedAtMs: null,
    revokedAtMs: null,
    status: 'active',
  });
  assert.equal('secret' in listed[0], false);
  assert.equal('secretHash' in listed[0], false);
  assert.equal('secret_hash' in listed[0], false);
  assert.equal('membership_version' in listed[0], false);

  h.setNow(1_800_000_005_000);
  const principal = await h.service.authorize({ secret: created.secret, projectId: 'project-1' });
  assert.deepEqual(principal, {
    subscriptionId: created.subscriptionId,
    subjectId: 'user-1',
    projectId: 'project-1',
    purpose: CALENDAR_SUBSCRIPTION_PURPOSE,
    audience: CALENDAR_SUBSCRIPTION_AUDIENCE,
  });
  assert.deepEqual(h.usages, [{ subscription_id: created.subscriptionId, used_at_ms: 1_800_000_005_000 }]);
  assert.equal(JSON.stringify(h.audits).includes(created.secret), false);
  assert.equal(JSON.stringify(h.audits).includes(stored.secret_hash), false);

  h.setNow(1_800_000_010_000);
  const rotated = await h.service.rotate({
    subjectId: 'user-1',
    projectId: 'project-1',
    subscriptionId: created.subscriptionId,
    expiresAtMs: 1_800_172_800_000,
  });
  assert.notEqual(rotated.secret, created.secret);
  assert.equal(rotated.subscriptionId, created.subscriptionId);
  assert.equal(rotated.rotatedAtMs, 1_800_000_010_000);
  assert.equal(rotated.expiresAtMs, 1_800_172_800_000);
  assert.equal(h.rotations.length, 1);
  await expectDomainError(
    h.service.authorize({ secret: created.secret, projectId: 'project-1' }),
    'calendar_subscription_unauthorized',
    401,
  );
  const rotatedPrincipal = await h.service.authorize({ secret: rotated.secret, projectId: 'project-1' });
  assert.equal(rotatedPrincipal.subscriptionId, created.subscriptionId);
  assert.equal(rotatedPrincipal.purpose, CALENDAR_SUBSCRIPTION_PURPOSE);
  assert.equal(JSON.stringify(h.audits).includes(rotated.secret), false);
  assert.equal(JSON.stringify(h.audits).includes(stored.secret_hash), false);
  assert.equal(JSON.stringify(h.audits).includes(h.rows.get(created.subscriptionId).secret_hash), false);

  h.setNow(1_800_000_020_000);
  const revoked = await h.service.revoke({
    subjectId: 'user-1',
    projectId: 'project-1',
    subscriptionId: created.subscriptionId,
  });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revokedAtMs, 1_800_000_020_000);
  const revokedAgain = await h.service.revoke({
    subjectId: 'user-1',
    projectId: 'project-1',
    subscriptionId: created.subscriptionId,
  });
  assert.equal(revokedAgain.revokedAtMs, revoked.revokedAtMs);
  await expectDomainError(
    h.service.authorize({ secret: rotated.secret, projectId: 'project-1' }),
    'calendar_subscription_unauthorized',
    401,
  );
  assert.equal(h.audits.filter((event) => event.event === 'calendar_subscription.revoked').length, 1);
  assert.equal(JSON.stringify(h.audits).includes(rotated.secret), false);
}

{
  const h = makeHarness({ auditThrows: true });
  const created = await h.service.create({
    subjectId: 'user-1', projectId: 'project-1', name: 'Ops', expiresAtMs: 1_800_000_100_000,
  });
  assert.ok(h.rows.has(created.subscriptionId));
  const principal = await h.service.authorize({ secret: created.secret, projectId: 'project-1' });
  assert.equal(principal.subjectId, 'user-1');
  const rotated = await h.service.rotate({
    subjectId: 'user-1', projectId: 'project-1', subscriptionId: created.subscriptionId, expiresAtMs: 1_800_000_200_000,
  });
  assert.ok(rotated.secret);
  const revoked = await h.service.revoke({ subjectId: 'user-1', projectId: 'project-1', subscriptionId: created.subscriptionId });
  assert.equal(revoked.status, 'revoked');
}

{
  const h = makeHarness();
  const created = await h.service.create({
    subjectId: 'user-1',
    projectId: 'project-1',
    name: 'Exact expiry',
    expiresAtMs: 1_800_000_060_000,
  });
  h.setNow(created.expiresAtMs);
  await expectDomainError(
    h.service.authorize({ secret: created.secret, projectId: 'project-1' }),
    'calendar_subscription_unauthorized',
    401,
  );
  const listed = await h.service.list({ subjectId: 'user-1', projectId: 'project-1' });
  assert.equal(listed[0].status, 'expired');
}

{
  const h = makeHarness();
  const created = await h.service.create({
    subjectId: 'user-1',
    projectId: 'project-1',
    name: 'Rejoin must rotate',
    expiresAtMs: 1_800_086_400_000,
  });
  h.activeMemberships.delete('user-1:project-1');
  h.activeMemberships.set('user-1:project-1', 4);
  assert.equal(h.rows.get(created.subscriptionId).revoked_at_ms, null);
  await expectDomainError(
    h.service.authorize({ secret: created.secret, projectId: 'project-1' }),
    'calendar_subscription_unauthorized',
    401,
  );
  const rotated = await h.service.rotate({
    subjectId: 'user-1',
    projectId: 'project-1',
    subscriptionId: created.subscriptionId,
    expiresAtMs: 1_800_172_800_000,
  });
  await expectDomainError(
    h.service.authorize({ secret: created.secret, projectId: 'project-1' }),
    'calendar_subscription_unauthorized',
    401,
  );
  const principal = await h.service.authorize({ secret: rotated.secret, projectId: 'project-1' });
  assert.equal(principal.purpose, CALENDAR_SUBSCRIPTION_PURPOSE);
  assert.equal(h.rows.get(created.subscriptionId).membership_version, 4);
}

{
  const h = makeHarness();
  const created = await h.service.create({
    subjectId: 'user-1',
    projectId: 'project-1',
    name: 'Rotate wins use',
    expiresAtMs: 1_800_086_400_000,
  });
  let releaseUsage;
  const usageGate = new Promise((resolve) => {
    releaseUsage = resolve;
  });
  const originalUsage = h.repository.recordUsageAtomically.bind(h.repository);
  h.repository.recordUsageAtomically = async (...args) => {
    await usageGate;
    return originalUsage(...args);
  };
  const authorizePromise = h.service.authorize({ secret: created.secret, projectId: 'project-1' });
  const rotated = await h.service.rotate({
    subjectId: 'user-1',
    projectId: 'project-1',
    subscriptionId: created.subscriptionId,
    expiresAtMs: 1_800_172_800_000,
  });
  releaseUsage();
  await expectDomainError(authorizePromise, 'calendar_subscription_unauthorized', 401);
  const principal = await h.service.authorize({ secret: rotated.secret, projectId: 'project-1' });
  assert.equal(principal.subscriptionId, created.subscriptionId);
}

{
  const h = makeHarness({ nowMs: Date.UTC(2028, 1, 28, 12, 0, 0) });
  const created = await h.service.create({
    subjectId: 'user-1',
    projectId: 'project-1',
    name: 'Leap-year feed',
    expiresAtMs: Date.UTC(2028, 2, 1, 12, 0, 0),
  });
  h.setNow(Date.UTC(2028, 1, 29, 12, 0, 0));
  const principal = await h.service.authorize({ secret: created.secret, projectId: 'project-1' });
  assert.equal(principal.purpose, CALENDAR_SUBSCRIPTION_PURPOSE);
  h.setNow(created.expiresAtMs);
  await expectDomainError(
    h.service.authorize({ secret: created.secret, projectId: 'project-1' }),
    'calendar_subscription_unauthorized',
    401,
  );
}

{
  const h = makeHarness();
  const maxExpiry = 1_800_000_000_000 + CALENDAR_SUBSCRIPTION_MAX_LIFETIME_MS;
  const created = await h.service.create({
    subjectId: 'user-1',
    projectId: 'project-1',
    name: 'Max lifetime',
    expiresAtMs: maxExpiry,
  });
  assert.equal(created.expiresAtMs, maxExpiry);
  await expectDomainError(
    h.service.create({
      subjectId: 'user-1',
      projectId: 'project-1',
      name: 'Too long',
      expiresAtMs: maxExpiry + 1,
    }),
    'calendar_subscription_expiry_invalid',
    400,
  );
}

console.log('calendar subscription domain behavior tests passed');
