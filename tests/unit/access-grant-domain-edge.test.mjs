import assert from 'node:assert/strict';
import { createAccessGrantService } from '../../server/access_grant_domain.mjs';

class MemoryRepository {
  constructor() { this.records = new Map(); }
  async insertGrant(record) { this.records.set(record.token_hash, structuredClone(record)); }
  async findGrantByHash(hash) { return this.records.get(hash) ?? null; }
  async consumeGrantAtomically() { return null; }
}

class ConsumableRepository extends MemoryRepository {
  constructor() {
    super();
    this.liveMembershipVersion = 1;
  }

  async consumeGrantAtomically(hash, expected) {
    const record = this.records.get(hash);
    if (!record || record.used_at_ms !== null || record.revoked_at_ms !== null) return null;
    if (expected.now_ms >= record.expires_at_ms) return null;
    if (record.purpose !== expected.purpose || record.audience !== expected.audience) return null;
    if (record.project_id !== expected.project_id) return null;
    if ((record.attachment_id ?? null) !== (expected.attachment_id ?? null)) return null;
    if (expected.membership_version !== undefined && expected.membership_version !== this.liveMembershipVersion) return null;
    record.used_at_ms = expected.now_ms;
    return structuredClone(record);
  }
}

const validPorts = () => ({
  repository: new MemoryRepository(),
  clock: { nowMs: () => 1_000 },
  randomSource: { randomBytes: (size) => new Uint8Array(size).fill(7) },
  auditSink: { record: async () => {} },
  projectAuthorization: { assertCanIssue: async () => {} },
  membershipRevocation: { assertActive: async () => 1 },
});

{
  const common = validPorts();
  assert.throws(() => createAccessGrantService({ ...common, repository: { insertGrant: async () => {} } }), /findGrantByHash/);
  assert.throws(() => createAccessGrantService({
    ...common,
    repository: { insertGrant: async () => {}, findGrantByHash: async () => null },
  }), /consumeGrantAtomically/);
}

for (const randomBytes of [() => new Uint8Array(31), () => Array(32).fill(1)]) {
  const service = createAccessGrantService({ ...validPorts(), randomSource: { randomBytes } });
  await assert.rejects(service.mint({
    subjectId: 'u', projectId: 'p', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 10,
  }), /random source must return 32 bytes/);
}

{
  let calls = 0;
  const service = createAccessGrantService({
    ...validPorts(),
    randomSource: {
      randomBytes(size) {
        calls += 1;
        return calls === 1 ? new Uint8Array(size).fill(9) : new Uint8Array(15).fill(9);
      },
    },
  });
  await assert.rejects(service.mint({
    subjectId: 'u', projectId: 'p', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 10,
  }), /random source must return 16 bytes for grant id/);
}

for (const nowMs of [() => Number.NaN, () => -1]) {
  const service = createAccessGrantService({ ...validPorts(), clock: { nowMs } });
  await assert.rejects(service.mint({
    subjectId: 'u', projectId: 'p', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 10,
  }), /clock must return a non-negative safe integer/);
}

{
  const service = createAccessGrantService({ ...validPorts(), clock: { nowMs: () => Number.MAX_SAFE_INTEGER - 500 } });
  await assert.rejects(service.mint({
    subjectId: 'u', projectId: 'p', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 1,
  }), (error) => error.code === 'access_grant_ttl_invalid' && error.status === 400);
}

{
  const service = createAccessGrantService(validPorts());
  await assert.rejects(service.mint({
    subjectId: null, projectId: 'p', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 10,
  }), (error) => error.code === 'access_grant_request_invalid');
  await assert.rejects(service.redeem({
    secret: null, purpose: 'stream', audience: 'scopeweave:stream', projectId: 'p',
  }), (error) => error.code === 'access_grant_unauthorized');
  await assert.rejects(service.redeem({
    secret: 'A'.repeat(43), purpose: 'stream', audience: 'scopeweave:stream', projectId: 'p',
  }), (error) => error.code === 'access_grant_unauthorized');
}

for (const membershipVersion of [
  undefined,
  null,
  -1,
  Number.NaN,
  '',
  '   ',
  'membership\nversion',
  'm'.repeat(129),
  {},
]) {
  const repository = new ConsumableRepository();
  let consumeCalls = 0;
  const consume = repository.consumeGrantAtomically.bind(repository);
  repository.consumeGrantAtomically = async (...args) => {
    consumeCalls += 1;
    return consume(...args);
  };
  const service = createAccessGrantService({
    ...validPorts(),
    repository,
    membershipRevocation: { assertActive: async () => membershipVersion },
  });
  const grant = await service.mint({
    subjectId: 'invalid-version-user',
    projectId: 'invalid-version-project',
    purpose: 'stream',
    audience: 'scopeweave:stream',
    ttlSeconds: 10,
  });
  await assert.rejects(service.redeem({
    secret: grant.secret,
    purpose: 'stream',
    audience: 'scopeweave:stream',
    projectId: 'invalid-version-project',
  }), (error) => error.code === 'access_grant_unauthorized' && error.status === 401);
  assert.equal(consumeCalls, 0, 'invalid membership versions must fail before the atomic consume boundary');
}

{
  const repository = new ConsumableRepository();
  repository.liveMembershipVersion = 'membership-v2';
  const service = createAccessGrantService({
    ...validPorts(),
    repository,
    membershipRevocation: { assertActive: async () => 'membership-v2' },
  });
  const grant = await service.mint({
    subjectId: 'string-version-user',
    projectId: 'string-version-project',
    purpose: 'stream',
    audience: 'scopeweave:stream',
    ttlSeconds: 10,
  });
  const redeemed = await service.redeem({
    secret: grant.secret,
    purpose: 'stream',
    audience: 'scopeweave:stream',
    projectId: 'string-version-project',
  });
  assert.equal(redeemed.subjectId, 'string-version-user');
}

{
  const repository = new ConsumableRepository();
  let rejectAudit = true;
  const service = createAccessGrantService({
    ...validPorts(),
    repository,
    auditSink: { async record() { if (rejectAudit) throw new Error('audit unavailable'); } },
  });
  const grant = await service.mint({
    subjectId: 'audit-user', projectId: 'audit-project', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 10,
  });
  assert.ok([...repository.records.values()].some(({ grant_id }) => grant_id === grant.grantId));
  rejectAudit = true;
  const redeemed = await service.redeem({
    secret: grant.secret, purpose: 'stream', audience: 'scopeweave:stream', projectId: 'audit-project',
  });
  assert.equal(redeemed.grantId, grant.grantId, 'audit delivery failure cannot turn durable consumption into a client-visible failure');
}

{
  const repository = new ConsumableRepository();
  let revokeDuringCheck = false;
  const service = createAccessGrantService({
    ...validPorts(),
    repository,
    membershipRevocation: {
      async assertActive() {
        const capturedVersion = repository.liveMembershipVersion;
        if (revokeDuringCheck) repository.liveMembershipVersion += 1;
        return capturedVersion;
      },
    },
  });
  const grant = await service.mint({
    subjectId: 'race-user', projectId: 'race-project', purpose: 'stream', audience: 'scopeweave:stream', ttlSeconds: 10,
  });
  revokeDuringCheck = true;
  await assert.rejects(service.redeem({
    secret: grant.secret, purpose: 'stream', audience: 'scopeweave:stream', projectId: 'race-project',
  }), (error) => error.code === 'access_grant_unauthorized' && error.status === 401);
}

console.log('✓ access-grant domain edge coverage passed');
