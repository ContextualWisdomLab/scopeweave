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
  'the application route graph serves the accessibility module without relying on the node entrypoint wrapper',
);
assert.match(
  dialogAccessibility.headers.get('content-type') || '',
  /^text\/javascript\b/,
  'the accessibility module is served as JavaScript',
);
assert.match(
  await dialogAccessibility.text(),
  /labelUnnamedDialogs/,
  'the served asset is the accessibility module rather than a fallback document',
);
assertBaselineSecurityHeaders(dialogAccessibility, 'accessibility module response');

const missing = await app.request('/api/definitely-missing');
assert.equal(missing.status, 404, 'unknown route remains a normal not-found response');
assertBaselineSecurityHeaders(missing, 'not-found response');

console.log('security header regression passed');
