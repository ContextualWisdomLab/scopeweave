import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
const { createRateLimitObservability } = await import('../../server/rate_limit.mjs');

const hooks = createRateLimitObservability();
hooks.onBlocked(
  { req: { method: 'GET', path: '/api/health' } },
  { startedAt: Date.now() },
);

const originalResponse = new Response('{malformed-json', {
  status: 200,
  headers: { 'content-type': 'application/json' },
});
const context = {
  req: {
    path: '/api/metrics',
    query: () => undefined,
  },
  res: originalResponse,
};

await assert.doesNotReject(
  () => hooks.afterNext(context),
  'metrics-folding failures never turn a successful request into an exception',
);
assert.equal(
  context.res,
  originalResponse,
  'a failed metrics fold leaves the original successful response object in place',
);
assert.equal(
  await originalResponse.text(),
  '{malformed-json',
  'a failed metrics fold reads only a clone so the original response body remains consumable',
);

console.log('rate-limit observability failure isolation passed');
