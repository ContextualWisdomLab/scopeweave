import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ACCESS_GRANT_AUDIENCES,
  ACCESS_GRANT_PURPOSES,
  AccessGrantError,
  createAccessGrantService,
} from '../../server/access_grant_domain.mjs';

class MemoryGrantRepository {
  constructor() {
    this.records = new Map();
    this.liveMembershipVersion = 1;
  }

  async insertGrant(record) {
    if (this.records.has(record.token_hash)) throw new Error('duplicate token hash');
    this.records.set(record.token_hash, structuredClone(record));
  }

  async findGrantByHash(tokenHash) {
    const record = this.records.get(tokenHash);
    return record ? structuredClone(record) : null;
  }

  async consumeGrantAtomically(tokenHash, expected) {
    const record = this.records.get(tokenHash);
    if (!record) return null;
    if (record.used_at_ms !== null || record.revoked_at_ms !== null) return null;
    if (expected.now_ms >= record.expires_at_ms) return null;
    if (record.purpose !== expected.purpose || record.audience !== expected.audience) return null;
    if (record.project_id !== expected.project_id) return null;
    if ((record.attachment_id ?? null) !== (expected.attachment_id ?? null)) return null;
    if (expected.membership_version !== this.liveMembershipVersion) return null;
    record.used_at_ms = expected.now_ms;
    return structuredClone(record);
  }
}

function deterministicRandomSource() {
  let call = 0;
  return {
    randomBytes(size) {
      call += 1;
      return Uint8Array.from({ length: size }, (_, index) => (call * 31 + index) % 256);
    },
  };
}

function makeHarness() {
  const repository = new MemoryGrantRepository();
  const auditEvents = [];
  const authorizationCalls = [];
  const membershipCalls = [];
  const clock = { current: Date.UTC(2026, 7, 15, 10, 0, 0), nowMs() { return this.current; } };
  const projectAuthorization = {
    async assertCanIssue(input) {
      authorizationCalls.push(structuredClone(input));
      if (input.projectId === 'hidden-project') throw new Error('project missing');
    },
  };
  const membershipRevocation = {
    async assertActive(input) {
      membershipCalls.push(structuredClone(input));
      if (input.subjectId === 'removed-user') throw new Error('membership revoked');
      return repository.liveMembershipVersion;
    },
  };
  const auditSink = { async record(event) { auditEvents.push(structuredClone(event)); } };
  const service = createAccessGrantService({
    repository,
    clock,
    randomSource: deterministicRandomSource(),
    auditSink,
    projectAuthorization,
    membershipRevocation,
  });
  return { service, repository, auditEvents, authorizationCalls, membershipCalls, clock };
}

async function expectGrantError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AccessGrantError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

for (const missing of [
  'repository',
  'clock',
  'randomSource',
  'auditSink',
  'projectAuthorization',
  'membershipRevocation',
]) {
  const harness = makeHarness();
  const dependencies = {
    repository: harness.repository,
    clock: harness.clock,
    randomSource: deterministicRandomSource(),
    auditSink: { record: async () => {} },
    projectAuthorization: { assertCanIssue: async () => {} },
    membershipRevocation: { assertActive: async () => 1 },
  };
  delete dependencies[missing];
  assert.throws(() => createAccessGrantService(dependencies), /access-grant dependency/);
}

{
  const { service, repository, auditEvents, authorizationCalls } = makeHarness();
  const grant = await service.mint({
    subjectId: 'user-7',
    projectId: 'project-42',
    purpose: ACCESS_GRANT_PURPOSES.STREAM,
    audience: ACCESS_GRANT_AUDIENCES.STREAM,
    ttlSeconds: 300,
  });
  assert.match(grant.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(grant.purpose, 'stream');
  assert.equal(grant.audience, 'scopeweave:stream');
  assert.equal(grant.attachmentId, null);
  assert.equal(grant.expiresAtMs, Date.UTC(2026, 7, 15, 10, 5, 0));
  assert.match(grant.grantId, /^agr_[a-f0-9]{32}$/);
  assert.deepEqual(authorizationCalls, [{ subjectId: 'user-7', projectId: 'project-42', purpose: 'stream', attachmentId: null }]);

  const tokenHash = createHash('sha256').update(grant.secret, 'utf8').digest('hex');
  assert.notEqual(
    grant.grantId.slice(4),
    tokenHash.slice(0, 32),
    'audit correlation identifiers are independently random, not secret-hash prefixes',
  );
  const stored = repository.records.get(tokenHash);
  assert.ok(stored, 'the repository is keyed by the SHA-256 token hash');
  assert.equal(stored.token_hash, tokenHash);
  assert.equal(stored.subject_id, 'user-7');
  assert.equal(stored.project_id, 'project-42');
  assert.equal(stored.used_at_ms, null);
  assert.equal(stored.revoked_at_ms, null);
  assert.equal(JSON.stringify(stored).includes(grant.secret), false, 'plaintext secret is never persisted');
  assert.equal(JSON.stringify(auditEvents).includes(grant.secret), false, 'plaintext secret is never audited');
  assert.equal(JSON.stringify(auditEvents).includes(tokenHash), false, 'token hash is not copied into audit metadata');
  assert.deepEqual(auditEvents[0], {
    event: 'access_grant.minted',
    grant_id: grant.grantId,
    subject_id: 'user-7',
    project_id: 'project-42',
    purpose: 'stream',
    audience: 'scopeweave:stream',
    attachment_id: null,
    expires_at_ms: grant.expiresAtMs,
  });

  const redeemed = await service.redeem({
    secret: grant.secret,
    purpose: 'stream',
    audience: 'scopeweave:stream',
    projectId: 'project-42',
  });
  assert.equal(redeemed.grantId, grant.grantId);
  assert.equal(redeemed.subjectId, 'user-7');
  assert.equal(redeemed.projectId, 'project-42');
  assert.equal(redeemed.attachmentId, null);
  assert.equal(repository.records.get(tokenHash).used_at_ms, Date.UTC(2026, 7, 15, 10, 0, 0));
  assert.deepEqual(auditEvents[1], {
    event: 'access_grant.consumed',
    grant_id: grant.grantId,
    subject_id: 'user-7',
    project_id: 'project-42',
    purpose: 'stream',
    audience: 'scopeweave:stream',
    attachment_id: null,
  });
  await expectGrantError(service.redeem({
    secret: grant.secret,
    purpose: 'stream',
    audience: 'scopeweave:stream',
    projectId: 'project-42',
  }), 'access_grant_unauthorized', 401);
}

{
  const { service } = makeHarness();
  const grant = await service.mint({
    subjectId: 'user-8',
    projectId: 'project-43',
    purpose: 'attachment_view',
    audience: 'scopeweave:attachment-view',
    attachmentId: 'attachment-9',
    ttlSeconds: 60,
  });
  assert.equal(grant.attachmentId, 'attachment-9');
  for (const input of [
    { purpose: 'stream', audience: 'scopeweave:stream', projectId: 'project-43', attachmentId: null },
    { purpose: 'attachment_view', audience: 'scopeweave:stream', projectId: 'project-43', attachmentId: 'attachment-9' },
    { purpose: 'attachment_view', audience: 'scopeweave:attachment-view', projectId: 'project-other', attachmentId: 'attachment-9' },
    { purpose: 'attachment_view', audience: 'scopeweave:attachment-view', projectId: 'project-43', attachmentId: 'attachment-other' },
  ]) {
    await expectGrantError(service.redeem({ secret: grant.secret, ...input }), 'access_grant_unauthorized', 401);
  }
  const redeemed = await service.redeem({
    secret: grant.secret,
    purpose: 'attachment_view',
    audience: 'scopeweave:attachment-view',
    projectId: 'project-43',
    attachmentId: 'attachment-9',
  });
  assert.equal(redeemed.attachmentId, 'attachment-9');
}

{
  const { service, clock } = makeHarness();
  const expiring = await service.mint({
    subjectId: 'user-expiry', projectId: 'project-expiry', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 1,
  });
  clock.current = expiring.expiresAtMs;
  await expectGrantError(service.redeem({
    secret: expiring.secret, purpose: 'stream', audience: 'scopeweave:stream', projectId: 'project-expiry',
  }), 'access_grant_unauthorized', 401);
}

{
  const { service } = makeHarness();
  for (const ttlSeconds of [0, 301, 1.5, Number.NaN]) {
    await expectGrantError(service.mint({
      subjectId: 'user', projectId: 'project', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds,
    }), 'access_grant_ttl_invalid', 400);
  }
  for (const bad of [
    { subjectId: '', projectId: 'p', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 10 },
    { subjectId: 'u', projectId: '', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 10 },
    { subjectId: 'u', projectId: 'p', purpose: 'calendar', audience: 'scopeweave:calendar', ttlSeconds: 10 },
    { subjectId: 'u', projectId: 'p', purpose: 'stream', audience: 'wrong', ttlSeconds: 10 },
    { subjectId: 'u', projectId: 'p', purpose: 'stream', audience: 'scopeweave:stream', attachmentId: 'unexpected', ttlSeconds: 10 },
    { subjectId: 'u', projectId: 'p', purpose: 'attachment_view', audience: 'scopeweave:attachment-view', ttlSeconds: 10 },
  ]) {
    await expectGrantError(service.mint(bad), 'access_grant_request_invalid', 400);
  }
  await expectGrantError(service.mint({
    subjectId: 'u', projectId: 'hidden-project', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 10,
  }), 'access_grant_not_authorized', 404);
}

{
  const { service, membershipCalls } = makeHarness();
  const grant = await service.mint({
    subjectId: 'removed-user', projectId: 'project-removed', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 10,
  });
  await expectGrantError(service.redeem({
    secret: grant.secret, purpose: 'stream', audience: 'scopeweave:stream', projectId: 'project-removed',
  }), 'access_grant_unauthorized', 401);
  assert.deepEqual(membershipCalls, [{ subjectId: 'removed-user', projectId: 'project-removed' }]);
}

{
  const { service } = makeHarness();
  for (const secret of ['', 'not-a-token', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + '!']) {
    await expectGrantError(service.redeem({
      secret, purpose: 'stream', audience: 'scopeweave:stream', projectId: 'project',
    }), 'access_grant_unauthorized', 401);
  }
}

{
  const { service } = makeHarness();
  const grant = await service.mint({
    subjectId: 'race-user', projectId: 'race-project', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 60,
  });
  const results = await Promise.allSettled([
    service.redeem({ secret: grant.secret, purpose: 'stream', audience: 'scopeweave:stream', projectId: 'race-project' }),
    service.redeem({ secret: grant.secret, purpose: 'stream', audience: 'scopeweave:stream', projectId: 'race-project' }),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1, 'exactly one concurrent consumer succeeds');
  const rejected = results.find(({ status }) => status === 'rejected');
  assert.equal(rejected.reason.code, 'access_grant_unauthorized');
}

console.log('✓ access-grant domain contract tests passed');
