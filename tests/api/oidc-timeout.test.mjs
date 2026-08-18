import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.OIDC_ISSUER = 'https://idp.example.test';
process.env.OIDC_CLIENT_ID = 'scopeweave-test';
process.env.OIDC_CLIENT_SECRET = 'scopeweave-secret';
process.env.OIDC_REDIRECT_URI = 'http://localhost/api/auth/oidc/callback';

let observedTimeout = null;
const originalTimeout = AbortSignal.timeout;
const originalFetch = globalThis.fetch;

AbortSignal.timeout = (milliseconds) => {
  observedTimeout = milliseconds;
  return new AbortController().signal;
};

globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== 'https://idp.example.test/token') {
    throw new Error(`unexpected outbound fetch: ${url}`);
  }
  const claims = Buffer.from(JSON.stringify({
    email: 'oidc-timeout@scopeweave.test',
  })).toString('base64url');
  return Response.json({ id_token: `header.${claims}.signature` });
};

try {
  const { app } = await import('../../server/app.mjs');

  const start = await app.request('/api/auth/oidc/start');
  assert.equal(start.status, 302, 'OIDC authorization flow starts');
  const location = start.headers.get('location');
  assert.ok(location, 'authorization redirect is present');
  const state = new URL(location).searchParams.get('state');
  assert.ok(state, 'authorization redirect carries state');

  const callback = await app.request(
    `/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=test-code`,
  );
  assert.equal(callback.status, 302, 'successful token exchange returns to the app');
  assert.equal(
    observedTimeout,
    3000,
    'OIDC token exchange uses the same bounded three-second provider budget as webhooks',
  );
} finally {
  AbortSignal.timeout = originalTimeout;
  globalThis.fetch = originalFetch;
}

console.log('oidc timeout regression passed');
