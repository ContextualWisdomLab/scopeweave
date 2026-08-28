import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const validJwtSecret = '0123456789abcdef0123456789abcdef';

function runProbe(source) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env },
    },
  );
}

const directBoundaryIdentityProbe = runProbe(`
  import assert from 'node:assert/strict';
  process.env.SCOPEWEAVE_DB = ':memory:';
  process.env.SCOPEWEAVE_JWT_SECRET = '${validJwtSecret}';
  process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '2';
  process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
  process.env.SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX = '8';
  delete process.env.SCOPEWEAVE_TRUSTED_PROXY_IPS;
  const { app } = await import('./server/application_routes.mjs');
  const statusFor = async (forwardedFor) => (await app.request('/api/health', {
    headers: { 'x-forwarded-for': forwardedFor },
  })).status;
  assert.equal(await statusFor('198.51.100.1'), 200);
  assert.equal(await statusFor('198.51.100.2'), 200);
  assert.equal(
    await statusFor('198.51.100.3'),
    429,
    'the supported shared boundary must ignore caller-controlled forwarding data when no trusted transport peer exists',
  );
`);
assert.equal(
  directBoundaryIdentityProbe.status,
  0,
  `Shared-boundary client-identity regression failed:\n${directBoundaryIdentityProbe.stderr}`,
);

const importOrderIsolationProbe = runProbe(`
  import assert from 'node:assert/strict';
  process.env.SCOPEWEAVE_DB = ':memory:';
  process.env.SCOPEWEAVE_JWT_SECRET = '${validJwtSecret}';
  process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '1';
  process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
  process.env.SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX = '8';
  delete process.env.SCOPEWEAVE_TRUSTED_PROXY_IPS;

  await import('./server/app.mjs');
  const { app: sharedApp } = await import('./server/application_routes.mjs');

  assert.equal((await sharedApp.request('/api/health')).status, 200);
  assert.equal(
    (await sharedApp.request('/api/health')).status,
    429,
    'importing the public app first must not leave the separately supported shared boundary cached with rate limiting disabled',
  );
`);
assert.equal(
  importOrderIsolationProbe.status,
  0,
  `Shared-boundary import-order regression failed:\n${importOrderIsolationProbe.stderr}`,
);

const inviteOrderingProbe = runProbe(`
  import assert from 'node:assert/strict';
  process.env.SCOPEWEAVE_DB = ':memory:';
  process.env.SCOPEWEAVE_JWT_SECRET = '${validJwtSecret}';
  process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '1';
  process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
  process.env.SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX = '8';
  delete process.env.SCOPEWEAVE_TRUSTED_PROXY_IPS;
  const [{ app }, { db }] = await Promise.all([
    import('./server/application_routes.mjs'),
    import('./server/db.mjs'),
  ]);
  const signup = await app.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'rate-limit-owner@example.com', password: 'correct-horse-battery-staple' }),
  });
  assert.equal(signup.status, 200);
  const { token } = await signup.json();
  db.exec('DROP TABLE invites');
  const blocked = await app.request('/api/invites/attacker-controlled-token/accept', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(
    blocked.status,
    429,
    'the supported shared-boundary limiter must reject an over-limit invite request before identity/invite database work',
  );
`);
assert.equal(
  inviteOrderingProbe.status,
  0,
  `Shared-boundary limiter-order regression failed:\n${inviteOrderingProbe.stderr}`,
);

console.log('✓ shared-boundary rate-limit regressions passed');