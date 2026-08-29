import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

test('cloud server serves the JSON sync bootstrap guard as JavaScript', async () => {
  const response = await app.request('/json-sync-bootstrap-guard.js');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/javascript\b/);
  assert.match(await response.text(), /updateJsonSyncAvailability/);
});
