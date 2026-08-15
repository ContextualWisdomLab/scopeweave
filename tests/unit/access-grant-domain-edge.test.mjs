import assert from 'node:assert/strict';
import { createAccessGrantService } from '../../server/access_grant_domain.mjs';

class MemoryRepository {
  constructor() { this.records = new Map(); }
  async insertGrant(record) { this.records.set(record.token_hash, structuredClone(record)); }
  async findGrantByHash(hash) { return this.records.get(hash) ?? null; }
  async consumeGrantAtomically() { return null; }
}

const validPorts = () => ({
  repository: new MemoryRepository(),
  clock: { nowMs: () => 1_000 },
  randomSource: { randomBytes: (size) => new Uint8Array(size).fill(7) },
  auditSink: { record: async () => {} },
  projectAuthorization: { assertCanIssue: async () => {} },
  membershipRevocation: { assertActive: async () => {} },
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

console.log('✓ access-grant domain edge coverage passed');
