import assert from 'node:assert';
import { runtimeApp } from '../../server/runtime-app.mjs';
import { app } from '../../server/app.mjs';

async function verifyHeaders(res, path, expectedStatus) {
  assert.equal(res.status, expectedStatus, `Expected status ${expectedStatus} for ${path}`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `Missing/incorrect nosniff on ${path}`);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', `Missing/incorrect SAMEORIGIN on ${path}`);
  // Exact configured HSTS value expected from Hono's default secureHeaders
  assert.equal(res.headers.get('strict-transport-security'), 'max-age=15552000; includeSubDomains', `Missing/incorrect exact HSTS on ${path}`);
}

async function runTests() {
  // Test behavior parity before/after header application on domain/body/status
  const appRes = await app.request('/api/health');
  const runtimeRes = await runtimeApp.request('/api/health');

  assert.equal(runtimeRes.status, appRes.status, 'Status behavior differs between app and runtime');
  assert.equal(await runtimeRes.text(), await appRes.text(), 'Body behavior differs between app and runtime');

  // 1. 2xx OK path
  let res = await runtimeApp.request('/api/health');
  await verifyHeaders(res, '/api/health', 200);

  // 2. 401 Unauthorized path (no token)
  res = await runtimeApp.request('/api/me');
  await verifyHeaders(res, '/api/me', 401);

  // 3. 404 Not Found path
  res = await runtimeApp.request('/api/does-not-exist');
  await verifyHeaders(res, '/api/does-not-exist', 404);

  console.log('✓ API security header tests passed (across 200, 401, 404 paths with exact HSTS)');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
