import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.ORCHESTRATOR_URL;

const { SECURE_HEADERS_OPTIONS, createRuntimeApp, runtimeApp } =
  await import('../../server/runtime-app.mjs');

assert.deepEqual(
  SECURE_HEADERS_OPTIONS,
  {
    crossOriginResourcePolicy: 'same-origin',
    crossOriginOpenerPolicy: 'same-origin',
    referrerPolicy: 'no-referrer',
    strictTransportSecurity: 'max-age=15552000; includeSubDomains',
    xContentTypeOptions: 'nosniff',
    xDnsPrefetchControl: 'off',
    xDownloadOptions: 'noopen',
    xFrameOptions: 'SAMEORIGIN',
    xPermittedCrossDomainPolicies: 'none',
    xXssProtection: '0',
  },
  'security-sensitive response headers must be an app-owned policy rather than mutable framework defaults',
);

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
    `${label} carries the application-owned HSTS policy`,
  );
  assert.equal(
    response.headers.get('x-powered-by'),
    null,
    `${label} does not disclose the framework through X-Powered-By`,
  );
}

const health = await runtimeApp.request('/api/health');
assert.equal(health.status, 200, 'health route remains available');
assertBaselineSecurityHeaders(health, 'successful API response');

const missing = await runtimeApp.request('/api/definitely-missing');
assert.equal(missing.status, 404, 'unknown route remains a normal not-found response');
assertBaselineSecurityHeaders(missing, 'not-found response');

const dialogModule = await runtimeApp.request('/dialog-accessibility.js');
assert.equal(
  dialogModule.status,
  200,
  'the runtime Hono app must serve every module referenced by index.html',
);
assert.match(
  dialogModule.headers.get('content-type') ?? '',
  /^text\/javascript(?:;|$)/i,
  'the dialog accessibility module must be served as JavaScript',
);
assertBaselineSecurityHeaders(dialogModule, 'dialog accessibility module response');
assert.match(
  await dialogModule.text(),
  /export function labelUnnamedDialogs\(/,
  'the static route must return the dialog accessibility module, not a fallback document',
);

function rejectingReadFile(code) {
  return async () => {
    const error = new Error(`fixture read failure: ${code}`);
    error.code = code;
    throw error;
  };
}

const missingStaticApp = createRuntimeApp({ readStaticFile: rejectingReadFile('ENOENT') });
const missingStatic = await missingStaticApp.request('/dialog-accessibility.js');
assert.equal(missingStatic.status, 404, 'missing static module is reported as not found');
assertBaselineSecurityHeaders(missingStatic, 'missing static module response');

const unreadableStaticApp = createRuntimeApp({ readStaticFile: rejectingReadFile('EACCES') });
const unreadableStatic = await unreadableStaticApp.request('/dialog-accessibility.js');
assert.equal(unreadableStatic.status, 500, 'unexpected static I/O failure is not misreported as 404');
assert.equal(await unreadableStatic.text(), 'Internal Server Error');
assertBaselineSecurityHeaders(unreadableStatic, 'static I/O failure response');

console.log('security header regression passed');
