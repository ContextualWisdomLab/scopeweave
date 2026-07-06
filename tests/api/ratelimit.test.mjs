// Rate-limit test — runs in its own process with the limiter enabled low.
// Run: node tests/api/ratelimit.test.mjs
import assert from 'node:assert';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '3';
const { app } = await import('../../server/app.mjs');

const req = (path, opts = {}) =>
  app.request(path, { ...opts, headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...(opts.headers || {}) } });

// first 3 pass, 4th+ are limited
let statuses = [];
for (let i = 0; i < 5; i++) statuses.push((await req('/api/health')).status);
assert.deepEqual(statuses.slice(0, 3), [200, 200, 200], 'first 3 under the limit');
assert.equal(statuses[3], 429, '4th request rate-limited');
const limited = await req('/api/health');
assert.equal(limited.status, 429, 'still limited within the window');
assert.ok(limited.headers.get('retry-after'), 'Retry-After header present');

// a different client IP has its own bucket
const other = await req('/api/health', { headers: { 'x-forwarded-for': '198.51.100.9' } });
assert.equal(other.status, 200, 'different IP not limited');

console.log('✓ rate-limit tests passed');
