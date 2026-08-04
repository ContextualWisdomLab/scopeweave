import test from 'node:test';
import assert from 'node:assert/strict';

test('Clearfolio jobStatus forwards the caller abort signal', async () => {
  process.env.CLEARFOLIO_URL = 'https://clearfolio.example';
  const originalFetch = globalThis.fetch;
  let observedSignal;
  globalThis.fetch = async (_url, options) => {
    observedSignal = options.signal;
    return { json: async () => ({ status: 'RUNNING' }) };
  };
  try {
    const { jobStatus } = await import('../../server/clearfolio.mjs?status-signal-test=1');
    const controller = new AbortController();
    const status = await jobStatus(1, 2, 'job-1', { signal: controller.signal });
    assert.equal(status, 'RUNNING');
    assert.equal(observedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLEARFOLIO_URL;
  }
});
