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
  import { randomUUID } from 'node:crypto';
  import { rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  const dbPath = join(tmpdir(), 'scopeweave-rate-limit-guard-' + randomUUID() + '.sqlite');
  process.env.SCOPEWEAVE_DB = dbPath;
  process.env.SCOPEWEAVE_JWT_SECRET = '${validJwtSecret}';
  process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '1';
  process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
  process.env.SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX = '8';
  process.env.SCOPEWEAVE_TRUSTED_PROXY_IPS = '127.0.0.1';
  const nodeEnv = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  let app;
  const requestFrom = (client, path, options = {}) => app.request(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}), 'x-forwarded-for': client },
  }, nodeEnv);
  const originalLog = console.log;
  const requestLogs = [];
  let db;
  console.log = (line) => requestLogs.push(String(line));
  try {
    const [{ app: loadedApp }, { db: loadedDb }, { signToken }] = await Promise.all([
      import('./server/application_routes.mjs'),
      import('./server/db.mjs'),
      import('./server/auth.mjs'),
    ]);
    app = loadedApp;
    db = loadedDb;
    db.prepare('INSERT INTO users(id,email,password_hash,name) VALUES(?,?,?,?)')
      .run(1, 'rate-limit-owner@example.com', '', '');
    db.prepare('INSERT INTO users(id,email,password_hash,name) VALUES(?,?,?,?)')
      .run(2, 'wrong-identity@example.com', '', '');
    db.prepare('INSERT INTO orgs(id,name,owner_id) VALUES(?,?,?)').run(1, 'rate-limit-org', 1);
    db.prepare('INSERT INTO invites(id,org_id,email,role,token,invited_by) VALUES(?,?,?,?,?,?)')
      .run(1, 1, 'intended-invitee@example.com', 'viewer', 'invite-ordering-sentinel', 1);
    const attackerToken = signToken({ sub: 2, email: 'wrong-identity@example.com', tv: 0 });
    const inviteToken = 'invite-ordering-sentinel';

    const first = await requestFrom('198.51.100.77', '/api/invites/' + inviteToken + '/accept', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + attackerToken },
    });
    assert.equal(first.status, 404, 'the first wrong-identity invite request reaches the guard');

    db.exec('DROP TABLE invites');
    const second = await requestFrom('198.51.100.77', '/api/invites/' + inviteToken + '/accept', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + attackerToken },
    });
    assert.equal(
      second.status,
      429,
      'the exhausted shared-boundary limiter rejects before invite identity-row lookup',
    );

    const inviteLogs = requestLogs
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((entry) => entry?.path === '/api/invites/:token/accept');
    assert.deepEqual(
      inviteLogs.map(({ method, status }) => ({ method, status })),
      [{ method: 'POST', status: 404 }, { method: 'POST', status: 429 }],
      'guard accounting and blocked observability retain the original POST method',
    );
  } finally {
    console.log = originalLog;
    db?.close();
    for (const suffix of ['', '-shm', '-wal']) rmSync(dbPath + suffix, { force: true });
  }
`);
assert.equal(
  inviteOrderingProbe.status,
  0,
  `Shared-boundary limiter-order regression failed:\n${inviteOrderingProbe.stderr}`,
);

console.log('✓ shared-boundary rate-limit regressions passed');
