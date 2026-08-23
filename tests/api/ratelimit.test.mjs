// Rate-limit test — runs in its own process with the limiter enabled low.
// Run: node tests/api/ratelimit.test.mjs
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { serve } from '@hono/node-server';

const validJwtSecret = '0123456789abcdef0123456789abcdef';
const importRateLimitApp = (overrides) => spawnSync(
  process.execPath,
  ['--input-type=module', '--eval', "await import('./server/app.mjs')"],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      SCOPEWEAVE_DB: ':memory:',
      SCOPEWEAVE_JWT_SECRET: validJwtSecret,
      SCOPEWEAVE_RATE_LIMIT_MAX: '3',
      SCOPEWEAVE_RATE_LIMIT_WINDOW_MS: '60000',
      SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX: '7',
      ...overrides,
    },
  },
);

for (const [name, value] of [
  ['SCOPEWEAVE_RATE_LIMIT_MAX', '-1'],
  ['SCOPEWEAVE_RATE_LIMIT_MAX', 'not-a-number'],
  ['SCOPEWEAVE_RATE_LIMIT_MAX', 'Infinity'],
  ['SCOPEWEAVE_RATE_LIMIT_WINDOW_MS', '0'],
  ['SCOPEWEAVE_RATE_LIMIT_WINDOW_MS', '-1'],
  ['SCOPEWEAVE_RATE_LIMIT_WINDOW_MS', 'not-a-number'],
  ['SCOPEWEAVE_RATE_LIMIT_WINDOW_MS', 'Infinity'],
  ['SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX', '0'],
  ['SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX', '-1'],
  ['SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX', 'not-a-number'],
  ['SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX', 'Infinity'],
]) {
  const result = importRateLimitApp({ [name]: value });
  assert.notEqual(result.status, 0, `${name}=${value} must fail startup instead of weakening limiter semantics`);
  assert.match(result.stderr, new RegExp(name), 'startup error identifies the invalid limiter setting');
}

assert.equal(
  importRateLimitApp({ SCOPEWEAVE_RATE_LIMIT_MAX: '0' }).status,
  0,
  'explicit zero keeps the documented disabled-limiter contract',
);

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '3';
process.env.SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX = '7';
process.env.SCOPEWEAVE_TRUSTED_PROXY_IPS = '127.0.0.1,::1,::ffff:127.0.0.1';
process.env.SCOPEWEAVE_JWT_SECRET = validJwtSecret;
const { app } = await import('../../server/app.mjs');

const req = (path, opts = {}) =>
  app.request(path, { ...opts, headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...(opts.headers || {}) } });

// In-process calls have no authenticated network peer, so they deliberately
// share one fail-closed bucket and ignore caller-controlled forwarding data.
let statuses = [];
for (let i = 0; i < 5; i++) statuses.push((await req('/api/health')).status);
assert.deepEqual(statuses.slice(0, 3), [200, 200, 200], 'first 3 under the limit');
assert.equal(statuses[3], 429, '4th request rate-limited');
const limited = await req('/api/health');
assert.equal(limited.status, 429, 'still limited within the window');
assert.ok(limited.headers.get('retry-after'), 'Retry-After header present');
const spoofed = await req('/api/health', { headers: { 'x-forwarded-for': '198.51.100.9' } });
assert.equal(spoofed.status, 429, 'untrusted X-Forwarded-For cannot select a new rate-limit bucket');

// Exercise the actual Node transport boundary. The loopback socket is an
// explicitly trusted ingress for this test, so only forwarding hops anchored
// to that peer may select a client bucket.
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
if (!server.listening) await once(server, 'listening');
try {
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server exposes a TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  const viaProxy = (forwarded) => fetch(`${base}/api/health`, {
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  });

  // A malicious client may alter left-side values, but a trusted proxy's
  // nearest appended client hop remains the same and therefore exhausts one
  // bucket rather than creating attacker-selected buckets.
  for (let i = 0; i < 3; i++) {
    assert.equal((await viaProxy(`192.0.2.${10 + i}, 203.0.113.7`)).status, 200);
  }
  assert.equal(
    (await viaProxy('192.0.2.99, 203.0.113.7')).status,
    429,
    'changing spoofable left-side forwarding data cannot evade the client bucket'
  );
  assert.equal(
    (await viaProxy('192.0.2.123, 198.51.100.9')).status,
    200,
    'a genuinely different nearest client hop receives a separate bucket'
  );

  // A trusted proxy appends the attacker's real nearest hop to any spoofable
  // client-supplied left-side forwarding chain. That left-side value must not
  // consume a different legitimate client's limiter state.
  for (let i = 0; i < 3; i++) {
    assert.equal(
      (await viaProxy('203.0.113.50, 198.51.100.50')).status,
      200,
      'attacker requests stay in the attacker bucket'
    );
  }
  assert.equal(
    (await viaProxy('203.0.113.50')).status,
    200,
    'spoofable left-side forwarding data cannot poison another client bucket'
  );

  // Trusted proxy chains are skipped from right to left until the first
  // untrusted client IP is reached.
  assert.equal((await viaProxy('198.51.100.10, 127.0.0.1')).status, 200);

  // Missing, invalid, or all-trusted forwarding evidence fails closed to the
  // actual peer instead of accepting arbitrary strings as identities.
  assert.equal((await viaProxy()).status, 200);
  assert.equal((await viaProxy('not-an-ip-one')).status, 200);
  assert.equal((await viaProxy('not-an-ip-two')).status, 200);
  assert.equal((await viaProxy('not-an-ip-three')).status, 429);
  assert.equal((await viaProxy('127.0.0.1')).status, 429);

  // Distinct trusted-proxy client addresses must not grow in-memory limiter
  // state without bound. Once the configured bucket cardinality is exhausted,
  // previously unseen clients share one fail-closed overflow bucket instead of
  // allocating attacker-controlled Map entries forever.
  assert.equal((await viaProxy('192.0.2.201')).status, 200);
  assert.equal((await viaProxy('192.0.2.202')).status, 200);
  assert.equal((await viaProxy('192.0.2.203')).status, 200);
  assert.equal(
    (await viaProxy('192.0.2.204')).status,
    429,
    'new client identities share a bounded overflow bucket after capacity is reached'
  );
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('✓ rate-limit tests passed');
