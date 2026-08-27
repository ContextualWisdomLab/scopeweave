import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.SCOPEWEAVE_DEV;
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;
delete process.env.OIDC_REDIRECT_URI;

const { app } = await import('../../server/app.mjs');

const start = await app.request('/api/auth/oidc/start?email=attacker@example.test');
assert.equal(
  start.status,
  404,
  'an unconfigured production deployment must not expose the built-in mock identity provider',
);

const mock = await app.request(
  '/api/auth/oidc/mock/authorize?state=attacker&email=attacker@example.test&redirect_uri=http://localhost/api/auth/oidc/callback',
);
assert.equal(
  mock.status,
  404,
  'the mock authorization endpoint is inaccessible unless explicit development mode is enabled',
);

const callback = await app.request('/api/auth/oidc/callback?state=attacker&code=attacker');
assert.equal(
  callback.status,
  404,
  'an unconfigured production callback cannot enter the mock-session path',
);

console.log('production OIDC fail-closed boundary regression passed');
