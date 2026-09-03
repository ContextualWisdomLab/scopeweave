import assert from 'node:assert';
import { runtimeApp } from '../../server/runtime-app.mjs';

async function runTests() {
  const res = await runtimeApp.request('/api/health');

  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(res.headers.get('strict-transport-security'));

  console.log('✓ API security header tests passed');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
