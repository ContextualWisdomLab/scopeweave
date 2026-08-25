import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

process.env.SCOPEWEAVE_DB = ':memory:';
delete process.env.SCOPEWEAVE_DEV;
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;
delete process.env.OIDC_REDIRECT_URI;
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.STRIPE_SECRET_KEY = 'sk_test_scopeweave_oidc_boundary';
process.env.STRIPE_PRICE_ID = 'price_scopeweave_oidc_boundary';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_oidc_boundary_secret';

const { app } = await import('../../server/app.mjs?oidc-production-boundary=1');
const { app: applicationRoutes } = await import('../../server/application_routes.mjs?oidc-shared-boundary=1');
const { app: internalCoreRoutes } = await import('../../server/application_routes_core.mjs?oidc-internal-boundary=1');

let response = await app.request('https://scopeweave.example/api/auth/oidc/start?email=victim@example.com');
assert.equal(response.status, 404, 'missing production OIDC configuration fails closed');
assert.equal(response.headers.get('location'), null, 'production never redirects into the built-in mock IdP');
assert.deepEqual(await response.json(), { error: 'sso not configured' });

response = await app.request(
  'https://scopeweave.example/api/auth/oidc/mock/authorize?state=attacker&email=victim@example.com&redirect_uri=https%3A%2F%2Fscopeweave.example%2Fapi%2Fauth%2Foidc%2Fcallback',
);
assert.equal(response.status, 404, 'built-in mock authorize endpoint is unreachable outside explicit development mode');
assert.equal(response.headers.get('location'), null, 'mock endpoint cannot mint a production callback code');
assert.deepEqual(await response.json(), { error: 'sso not configured' });

response = await applicationRoutes.request('https://scopeweave.example/api/auth/oidc/start?email=victim@example.com');
assert.equal(response.status, 404, 'shared route graph also fails closed when production OIDC is unconfigured');
assert.equal(response.headers.get('location'), null, 'shared route graph never redirects into the built-in mock IdP');
assert.deepEqual(await response.json(), { error: 'sso not configured' });

response = await applicationRoutes.request(
  'https://scopeweave.example/api/auth/oidc/mock/authorize?state=attacker&email=victim@example.com&redirect_uri=https%3A%2F%2Fscopeweave.example%2Fapi%2Fauth%2Foidc%2Fcallback',
);
assert.equal(response.status, 404, 'shared route graph keeps the mock authorize endpoint closed outside explicit development mode');
assert.equal(response.headers.get('location'), null, 'shared route graph cannot mint a production callback code');
assert.deepEqual(await response.json(), { error: 'sso not configured' });

response = await internalCoreRoutes.request('https://scopeweave.example/api/auth/oidc/start?email=victim@example.com');
assert.equal(response.status, 404, 'internal core graph fails closed rather than enabling mock OIDC when production configuration is absent');
assert.equal(response.headers.get('location'), null, 'internal core graph never redirects into the mock IdP without explicit development mode');
assert.deepEqual(await response.json(), { error: 'sso not configured' });

response = await internalCoreRoutes.request(
  'https://scopeweave.example/api/auth/oidc/mock/authorize?state=attacker&email=victim@example.com&redirect_uri=https%3A%2F%2Fscopeweave.example%2Fapi%2Fauth%2Foidc%2Fcallback',
);
assert.equal(response.status, 404, 'internal core mock authorize stays disabled outside explicit development mode');
assert.equal(response.headers.get('location'), null, 'internal core cannot mint a production callback code');
assert.deepEqual(await response.json(), { error: 'mock disabled' });

const forgedIdentityRegression = String.raw`
  import assert from 'node:assert/strict';

  process.env.SCOPEWEAVE_DB = ':memory:';
  delete process.env.SCOPEWEAVE_DEV;
  process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.STRIPE_SECRET_KEY = 'sk_test_scopeweave_oidc_signature';
  process.env.STRIPE_PRICE_ID = 'price_scopeweave_oidc_signature';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_oidc_signature_secret';
  process.env.OIDC_ISSUER = 'https://issuer.example';
  process.env.OIDC_CLIENT_ID = 'scopeweave-client';
  process.env.OIDC_CLIENT_SECRET = 'scopeweave-secret';
  process.env.OIDC_REDIRECT_URI = 'https://scopeweave.example/api/auth/oidc/callback';

  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const forgedIdToken = [
    encode({ alg: 'none', typ: 'JWT' }),
    encode({
      iss: process.env.OIDC_ISSUER,
      aud: process.env.OIDC_CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
      email: 'attacker-chosen@example.com',
    }),
    '',
  ].join('.');

  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://issuer.example/token', 'callback exchanges the authorization code only with the configured issuer');
    return new Response(JSON.stringify({ id_token: forgedIdToken }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { app: configuredRoutes } = await import('./server/application_routes.mjs?oidc-forged-token-regression=1');
  const start = await configuredRoutes.request('https://scopeweave.example/api/auth/oidc/start');
  assert.equal(start.status, 302, 'configured OIDC starts the authorization-code flow');
  const authorization = new URL(start.headers.get('location'));
  const state = authorization.searchParams.get('state');
  assert.ok(state, 'authorization request carries a server-generated state');

  const callback = await configuredRoutes.request(
    'https://scopeweave.example/api/auth/oidc/callback?state=' + encodeURIComponent(state) + '&code=attacker-code',
  );
  assert.equal(callback.status, 400, 'an unsigned or otherwise unverified identity token must never mint a ScopeWeave session');
  assert.equal(callback.headers.get('location'), null, 'rejected identity tokens never return an application session fragment');
`;

const forgedIdentityResult = spawnSync(
  process.execPath,
  ['--input-type=module', '--eval', forgedIdentityRegression],
  { cwd: process.cwd(), encoding: 'utf8' },
);
assert.equal(
  forgedIdentityResult.status,
  0,
  `configured production OIDC must authenticate the IdP before trusting identity claims\nstdout:\n${forgedIdentityResult.stdout}\nstderr:\n${forgedIdentityResult.stderr}`,
);

console.log('OIDC production fail-closed regression passed');
