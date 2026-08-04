import test from 'node:test';
import assert from 'node:assert/strict';

test('Clearfolio jobStatus enforces endpoint, signal, and HTTP status contracts', async () => {
  process.env.CLEARFOLIO_URL = 'https://clearfolio.example';
  const originalFetch = globalThis.fetch;
  let observedUrl;
  let observedSignal;
  let downstreamResponse = {
    ok: true,
    status: 200,
    json: async () => ({ status: 'RUNNING' }),
  };
  globalThis.fetch = async (url, options) => {
    observedUrl = String(url);
    observedSignal = options.signal;
    return downstreamResponse;
  };

  try {
    const { jobStatus } = await import('../../server/clearfolio.mjs?status-signal-test=1');
    const controller = new AbortController();
    const status = await jobStatus(1, 2, 'job-1', { signal: controller.signal });
    assert.equal(status, 'RUNNING');
    assert.equal(
      observedUrl,
      'https://clearfolio.example/api/v1/convert/jobs/job-1',
    );
    assert.equal(observedSignal, controller.signal);

    downstreamResponse = {
      ok: false,
      status: 503,
      json: async () => ({ message: 'sensitive downstream text' }),
    };
    await assert.rejects(
      () => jobStatus(1, 2, 'job-1'),
      /clearfolio status failed \(503\)/,
    );

    downstreamResponse = {
      ok: true,
      status: 200,
      json: async () => ({}),
    };
    await assert.rejects(
      () => jobStatus(1, 2, 'job-1'),
      /clearfolio status response invalid/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLEARFOLIO_URL;
  }
});
