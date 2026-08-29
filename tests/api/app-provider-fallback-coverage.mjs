// Hosted OIDC fallback coverage for production branches that only exist when
// no explicit redirect URI is configured. The public start/callback flow proves
// origin-derived redirect binding and malformed/valid id_token handling.
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '0';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '1000';
process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
process.env.OIDC_ISSUER = 'https://idp.example.test/';
process.env.OIDC_CLIENT_ID = 'scopeweave-client';
process.env.OIDC_CLIENT_SECRET = 'scopeweave-secret';
delete process.env.OIDC_REDIRECT_URI;
delete process.env.ORCHESTRATOR_URL;
delete process.env.CLEARFOLIO_URL;

const { app } = await import('../../server/app.mjs');
const nativeFetch = globalThis.fetch;

const req = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return app.request(path, { ...options, headers });
};

async function startHostedFlow() {
  const start = await req('/api/auth/oidc/start');
  assert.equal(start.status, 302);
  const authorization = new URL(start.headers.get('location'));
  assert.equal(authorization.origin, 'https://idp.example.test');
  assert.equal(authorization.pathname, '/authorize');
  assert.equal(authorization.searchParams.get('redirect_uri'), 'http://localhost/api/auth/oidc/callback');
  return authorization.searchParams.get('state');
}

function hostedToken(email) {
  const claims = Buffer.from(JSON.stringify({ email })).toString('base64url');
  return `header.${claims}.signature`;
}

try {
  // A syntactically present id_token with an empty payload exercises both the
  // missing JWT-segment and decoded-empty-object fallbacks. It must fail closed
  // as a stable public 400 rather than throwing a JSON parse exception.
  globalThis.fetch = async () => new Response(JSON.stringify({ id_token: 'header..signature' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  let state = await startHostedFlow();
  let response = await req(`/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=empty-claims`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'no email claim' });

  // A valid hosted token uses the same origin-derived redirect URI during the
  // token exchange and completes the browser-safe fragment redirect.
  let observedTokenRequest;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    observedTokenRequest = request.clone();
    return new Response(JSON.stringify({ id_token: hostedToken('fallback-hosted@example.com') }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  state = await startHostedFlow();
  response = await req(`/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=valid-hosted`);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') || '', /^\/#token=/);
  assert.equal(observedTokenRequest.url, 'https://idp.example.test/token');
  const tokenForm = new URLSearchParams(await observedTokenRequest.text());
  assert.equal(tokenForm.get('redirect_uri'), 'http://localhost/api/auth/oidc/callback');
  assert.equal(tokenForm.get('client_id'), 'scopeweave-client');
  assert.equal(tokenForm.get('client_secret'), 'scopeweave-secret');
  assert.equal(tokenForm.get('code'), 'valid-hosted');
  assert.ok(tokenForm.get('code_verifier'));
} finally {
  globalThis.fetch = nativeFetch;
}

console.log('app hosted provider fallback coverage: ok');
