import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const callerFetch = async (input, init) => {
  const request = new Request(input, init);
  return new Response(request.url, { status: 200 });
};
globalThis.fetch = callerFetch;

await import('../../server/app.mjs');

test('importing the ScopeWeave app preserves the caller-owned process fetch implementation', () => {
  assert.equal(
    globalThis.fetch,
    callerFetch,
    'ScopeWeave security boundaries must be explicit collaborators rather than a process-wide fetch monkey patch',
  );
});
