import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const regression = String.raw`
  import assert from 'node:assert/strict';

  process.env.SCOPEWEAVE_DB = ':memory:';
  delete process.env.SCOPEWEAVE_DEV;
  process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.STRIPE_SECRET_KEY = 'sk_test_scopeweave_oidc_core_boundary';
  process.env.STRIPE_PRICE_ID = 'price_scopeweave_oidc_core_boundary';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_oidc_core_boundary_secret';
  process.env.OIDC_ISSUER = 'https://issuer.example';
  process.env.OIDC_CLIENT_ID = 'scopeweave-client';
  process.env.OIDC_CLIENT_SECRET = 'scopeweave-secret';
  process.env.OIDC_REDIRECT_URI = 'https://scopeweave.example/api/auth/oidc/callback';

  const { app: internalCoreRoutes } = await import('./server/application_routes_core.mjs?oidc-core-production-failclosed=1');

  let response = await internalCoreRoutes.request('https://scopeweave.example/api/auth/oidc/start');
  assert.equal(response.status, 404, 'internal core graph must not expose production OIDC authorization');
  assert.equal(response.headers.get('location'), null, 'internal core graph never redirects to a production issuer');
  assert.deepEqual(await response.json(), { error: 'sso not configured' });

  response = await internalCoreRoutes.request(
    'https://scopeweave.example/api/auth/oidc/callback?state=attacker-state&code=attacker-code',
  );
  assert.equal(response.status, 404, 'internal core graph must not process production OIDC callbacks');
  assert.equal(response.headers.get('location'), null, 'internal core callback cannot mint an application session');
  assert.deepEqual(await response.json(), { error: 'sso not configured' });
`;

const result = spawnSync(
  process.execPath,
  ['--input-type=module', '--eval', regression],
  { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
);

assert.equal(
  result.status,
  0,
  `direct core production OIDC fail-closed regression failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
);

console.log('Direct core production OIDC fail-closed regression passed');
