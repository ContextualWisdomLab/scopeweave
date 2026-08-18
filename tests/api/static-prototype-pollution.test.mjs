// Regression: static-file allowlists must not inherit attacker-controlled Object.prototype entries.
// Run: node tests/api/static-prototype-pollution.test.mjs
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const probePath = '/prototype-pollution-probe';
Object.defineProperty(Object.prototype, probePath, {
  configurable: true,
  value: ['package.json', 'application/json; charset=utf-8'],
});

try {
  const { app } = await import('../../server/app.mjs');
  const response = await app.request(probePath);
  const responseBody = await response.text();

  assert.equal(
    response.status,
    404,
    'prototype-polluted static lookup must not resolve inherited allowlist entries',
  );
  assert.doesNotMatch(
    responseBody,
    /"name"\s*:\s*"scopeweave"/,
    'prototype pollution must never expose package metadata through the static route',
  );
} finally {
  delete Object.prototype[probePath];
}

console.log('✓ static prototype-pollution regression passed');
