import test from 'node:test';
import assert from 'node:assert';

process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

test('runtime-app exports an app', async () => {
  const { app } = await import('../../server/runtime-app.mjs');
  assert.ok(app);
  assert.ok(typeof app.fetch === 'function');
});
