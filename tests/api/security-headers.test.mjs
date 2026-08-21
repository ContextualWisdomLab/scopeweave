import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.ORCHESTRATOR_URL;

const { app } = await import('../../server/app.mjs');

function assertBaselineSecurityHeaders(response, label) {
  assert.equal(
    response.headers.get('x-content-type-options'),
    'nosniff',
    `${label} prevents MIME sniffing`,
  );
  assert.equal(
    response.headers.get('x-frame-options'),
    'SAMEORIGIN',
    `${label} prevents cross-origin framing`,
  );
  assert.equal(
    response.headers.get('cross-origin-resource-policy'),
    'same-origin',
    `${label} keeps resources same-origin by default`,
  );
  assert.equal(
    response.headers.get('cross-origin-opener-policy'),
    'same-origin',
    `${label} isolates the top-level browsing context`,
  );
  assert.equal(
    response.headers.get('referrer-policy'),
    'no-referrer',
    `${label} does not disclose referrer URLs`,
  );
  assert.equal(
    response.headers.get('strict-transport-security'),
    'max-age=15552000; includeSubDomains',
    `${label} carries the framework baseline HSTS policy`,
  );
  assert.equal(
    response.headers.get('x-powered-by'),
    null,
    `${label} does not disclose the framework through X-Powered-By`,
  );
}

const health = await app.request('/api/health');
assert.equal(health.status, 200, 'health route remains available');
assertBaselineSecurityHeaders(health, 'successful API response');

const dialogAccessibility = await app.request('/dialog-accessibility.js');
assert.equal(
  dialogAccessibility.status,
  200,
  'the canonical app serves the dialog accessibility module without a server-entrypoint wrapper',
);
assert.match(
  dialogAccessibility.headers.get('content-type') ?? '',
  /^text\/javascript; charset=utf-8/i,
  'the dialog accessibility module is served as JavaScript',
);
assert.match(
  await dialogAccessibility.text(),
  /aria-labelledby/,
  'the served dialog accessibility module contains its accessibility behavior',
);
assertBaselineSecurityHeaders(dialogAccessibility, 'dialog accessibility static response');

const missing = await app.request('/api/definitely-missing');
assert.equal(missing.status, 404, 'unknown route remains a normal not-found response');
assertBaselineSecurityHeaders(missing, 'not-found response');

console.log('security header and static-module regression passed');
