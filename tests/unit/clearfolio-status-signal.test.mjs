import test from 'node:test';
import assert from 'node:assert/strict';

test('Clearfolio jobStatus enforces endpoint, signal, HTTP, and payload contracts', async () => {
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
      (error) => {
        assert.equal(error.message, 'clearfolio status failed (503)');
        assert.doesNotMatch(error.message, /sensitive downstream text/);
        return true;
      },
    );

    const malformedPayloads = [
      {
        label: 'unparseable JSON',
        json: async () => { throw new SyntaxError('downstream parser detail'); },
      },
      { label: 'null body', json: async () => null },
      { label: 'primitive body', json: async () => 'RUNNING' },
      { label: 'array body', json: async () => [{ status: 'RUNNING' }] },
      { label: 'missing status', json: async () => ({}) },
      { label: 'non-string status', json: async () => ({ status: 200 }) },
      { label: 'empty status', json: async () => ({ status: '' }) },
    ];

    for (const malformed of malformedPayloads) {
      downstreamResponse = {
        ok: true,
        status: 200,
        json: malformed.json,
      };
      await assert.rejects(
        () => jobStatus(1, 2, 'job-1'),
        (error) => {
          assert.equal(error.message, 'clearfolio status response invalid');
          assert.doesNotMatch(error.message, /downstream parser detail/);
          return true;
        },
        malformed.label,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLEARFOLIO_URL;
  }
});
