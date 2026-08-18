import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.OIDC_ISSUER = 'https://idp.example.test';
process.env.OIDC_CLIENT_ID = 'scopeweave-capacity-test';
process.env.OIDC_CLIENT_SECRET = 'scopeweave-capacity-secret';
process.env.OIDC_REDIRECT_URI = 'http://localhost/api/auth/oidc/callback';
delete process.env.SCOPEWEAVE_DEV;

const originalNow = Date.now;
let now = 1_800_000_000_000;
Date.now = () => now;

try {
  const { app } = await import('../../server/app_core.mjs');

  for (let index = 0; index < 256; index += 1) {
    const response = await app.request('/api/auth/oidc/start');
    assert.equal(
      response.status,
      302,
      'the core OIDC state store admits flows until its bounded capacity is full',
    );
  }

  const saturated = await app.request('/api/auth/oidc/start');
  assert.equal(
    saturated.status,
    503,
    'the core OIDC state store fails closed instead of growing without bound',
  );
  assert.deepEqual(
    await saturated.json(),
    { error: 'OIDC temporarily unavailable' },
    'capacity exhaustion returns a stable non-secret response',
  );

  now += (5 * 60 * 1000) + 1;
  const afterExpiry = await app.request('/api/auth/oidc/start');
  assert.equal(
    afterExpiry.status,
    302,
    'expired state entries are reclaimed before applying the capacity limit',
  );
} finally {
  Date.now = originalNow;
}

console.log('core OIDC state capacity and expiry reclamation regression passed');
