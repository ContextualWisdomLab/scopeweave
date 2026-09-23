// Regression contract for the unauthenticated login timing shape.
// Run: node tests/api/login-timing-shape.test.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

const request = (path, options = {}) => app.request(path, {
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});
const json = (value) => JSON.stringify(value);

let response = await request('/api/auth/signup', {
  method: 'POST',
  body: json({ email: 'known@example.com', password: 'password123', name: 'Known' }),
});
assert.equal(response.status, 200, 'fixture signup succeeds');

async function rejectedLoginElapsedMs(email) {
  const started = performance.now();
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: json({ email, password: 'definitely-wrong-password' }),
  });
  const elapsed = performance.now() - started;
  assert.equal(result.status, 401, `${email} rejects invalid credentials`);
  return elapsed;
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

// Warm both code paths before collecting the bounded in-process sample.
await rejectedLoginElapsedMs('known@example.com');
await rejectedLoginElapsedMs('missing@example.com');

const known = [];
const missing = [];
for (let index = 0; index < 5; index += 1) {
  known.push(await rejectedLoginElapsedMs('known@example.com'));
  missing.push(await rejectedLoginElapsedMs(`missing-${index}@example.com`));
}

const knownMedian = median(known);
const missingMedian = median(missing);
const lowerBound = knownMedian * 0.25;
const upperBound = knownMedian * 4;

assert.ok(
  missingMedian >= lowerBound && missingMedian <= upperBound,
  `missing-user login must retain the password-verification cost shape: known=${knownMedian.toFixed(2)}ms missing=${missingMedian.toFixed(2)}ms`,
);

console.log('✓ login timing-shape regression passed');
