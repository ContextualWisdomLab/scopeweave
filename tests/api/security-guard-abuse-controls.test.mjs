import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(tmpdir(), `scopeweave-guard-abuse-${randomUUID()}.sqlite`);
process.env.SCOPEWEAVE_DB = dbPath;
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '1';
process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
process.env.STRIPE_SECRET_KEY = 'sk_test_scopeweave_guard_abuse';
process.env.STRIPE_PRICE_ID = 'price_scopeweave_guard_abuse';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_guard_abuse';
delete process.env.SCOPEWEAVE_DEV;
delete process.env.OIDC_ISSUER;

const originalLog = console.log;
const requestLogs = [];
console.log = (line) => requestLogs.push(String(line));

try {
  const { app } = await import('../../server/application_routes.mjs?security-guard-abuse=1');
  const url = 'https://scopeweave.example/api/auth/oidc/start';

  let response = await app.request(url);
  assert.equal(response.status, 404, 'unconfigured production OIDC fails closed');
  assert.deepEqual(await response.json(), { error: 'sso not configured' });

  response = await app.request(url);
  assert.equal(
    response.status,
    429,
    'a repeated guard-rejected request still passes through the existing abuse-control middleware',
  );
  assert.deepEqual(await response.json(), { error: 'rate limit exceeded' });

  const oidcLogs = requestLogs
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((entry) => entry?.path === '/api/auth/oidc/start');
  assert.deepEqual(
    oidcLogs.map(({ status }) => status),
    [404, 429],
    'guard rejections remain in structured request observability instead of bypassing it',
  );
} finally {
  console.log = originalLog;
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

console.log('security guard abuse-control regression passed');
