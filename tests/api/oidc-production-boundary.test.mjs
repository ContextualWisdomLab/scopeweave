import assert from 'node:assert/strict';

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

console.log('OIDC production fail-closed regression passed');
