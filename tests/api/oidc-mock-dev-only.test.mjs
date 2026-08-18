import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.SCOPEWEAVE_DEV;
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;
delete process.env.OIDC_REDIRECT_URI;

const { app } = await import('../../server/app.mjs');

test('built-in OIDC mock cannot authenticate when development mode is disabled', async () => {
  let response = await app.request('http://localhost/api/auth/oidc/start?email=attacker@scopeweave.test');
  assert.equal(response.status, 404, 'production-like deployment must not expose mock OIDC start');

  response = await app.request(
    'http://localhost/api/auth/oidc/mock/authorize?state=fake&email=attacker%40scopeweave.test&redirect_uri=http%3A%2F%2Flocalhost%2Fapi%2Fauth%2Foidc%2Fcallback',
  );
  assert.equal(response.status, 404, 'production-like deployment must not expose mock OIDC authorize');
});
