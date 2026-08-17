import test from 'node:test';
import assert from 'node:assert/strict';

const HMAC_SECRET = 'clearfolio-shared-secret-32-bytes!!';
process.env.CLEARFOLIO_URL = 'https://clearfolio.example';
process.env.CLEARFOLIO_HMAC_SECRET = HMAC_SECRET;
delete process.env.SCOPEWEAVE_DEV;

const originalFetch = globalThis.fetch;
const calls = [];
let responder;
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (!responder) throw new Error('test responder is not configured');
  return responder(url, options);
};

const {
  CLEARFOLIO_MAX_RESPONSE_BYTES,
  CLEARFOLIO_REQUEST_TIMEOUT_MS,
  artifactUrl,
  jobStatus,
  submitJob,
} = await import(`../../server/clearfolio.mjs?provider-boundary=${Date.now()}`);

const jsonResponse = (value, init = {}) => new Response(JSON.stringify(value), {
  status: init.status ?? 200,
  headers: {
    'content-type': init.contentType ?? 'application/json; charset=utf-8',
    ...(init.headers || {}),
  },
});

function useResponse(value, init = {}) {
  responder = async () => jsonResponse(value, init);
}

test.after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLEARFOLIO_URL;
  delete process.env.CLEARFOLIO_HMAC_SECRET;
});

test('provider requests disable redirects and carry a bounded total-request signal', async () => {
  useResponse({ status: 'RUNNING' });
  const before = calls.length;
  assert.equal(await jobStatus(1, 2, 'job-1'), 'RUNNING');
  assert.equal(calls.length, before + 1);
  const { options } = calls.at(-1);
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  assert.equal(Number.isSafeInteger(CLEARFOLIO_REQUEST_TIMEOUT_MS), true);
  assert.equal(CLEARFOLIO_REQUEST_TIMEOUT_MS > 0 && CLEARFOLIO_REQUEST_TIMEOUT_MS <= 30_000, true);
});

test('status response requires JSON media type before parsing', async () => {
  useResponse({ status: 'RUNNING' }, { contentType: 'text/plain' });
  await assert.rejects(
    () => jobStatus(1, 2, 'job-1'),
    /clearfolio status response invalid/,
  );
});

test('declared and streamed provider response bodies are bounded', async () => {
  assert.equal(Number.isSafeInteger(CLEARFOLIO_MAX_RESPONSE_BYTES), true);
  assert.equal(CLEARFOLIO_MAX_RESPONSE_BYTES >= 1024 && CLEARFOLIO_MAX_RESPONSE_BYTES <= 1024 * 1024, true);

  useResponse({ status: 'RUNNING' }, {
    headers: { 'content-length': String(CLEARFOLIO_MAX_RESPONSE_BYTES + 1) },
  });
  await assert.rejects(
    () => jobStatus(1, 2, 'job-1'),
    /clearfolio status response invalid/,
  );

  responder = async () => new Response(
    new Uint8Array(CLEARFOLIO_MAX_RESPONSE_BYTES + 1),
    { headers: { 'content-type': 'application/json' } },
  );
  await assert.rejects(
    () => jobStatus(1, 2, 'job-1'),
    /clearfolio status response invalid/,
  );
});

test('caller cancellation remains composed with the provider request budget', async () => {
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled with private detail'));
  responder = async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw options.signal.reason;
  };
  await assert.rejects(
    () => jobStatus(1, 2, 'job-1', { signal: controller.signal }),
    (error) => {
      assert.equal(error.message, 'clearfolio status unavailable');
      assert.doesNotMatch(error.message, /private detail/);
      return true;
    },
  );
});

test('document validation fails before Blob, FormData, or provider transport', async () => {
  const before = calls.length;
  const invalidDocuments = [
    null,
    { name: '', mime: 'text/plain', bytes: Buffer.from('x') },
    { name: 'x'.repeat(513), mime: 'text/plain', bytes: Buffer.from('x') },
    { name: 'x.txt', mime: 'x'.repeat(256), bytes: Buffer.from('x') },
    { name: 'x.txt', mime: 'text/plain', bytes: 'not-bytes' },
    { name: 'x.txt', mime: 'text/plain', bytes: new Uint8Array(10 * 1024 * 1024 + 1) },
  ];
  for (const document of invalidDocuments) {
    await assert.rejects(
      () => submitJob(1, 2, document),
      /clearfolio document invalid/,
    );
  }
  assert.equal(calls.length, before, 'invalid documents never reach provider transport');
});

test('provider job identifiers are bounded before URL construction', async () => {
  const before = calls.length;
  for (const operation of [
    () => jobStatus(1, 2, 'x'.repeat(257)),
    () => artifactUrl(1, 2, 'x'.repeat(257)),
  ]) {
    await assert.rejects(operation, /clearfolio job id invalid/);
  }
  assert.equal(calls.length, before, 'oversized job identifiers never reach provider transport');
});

test('artifact redirects remain bound to the configured provider origin', async () => {
  for (const artifactUrlValue of [
    'https://cdn.example/file.pdf',
    'https://user:pass@clearfolio.example/file.pdf',
    'https://clearfolio.example/file.pdf#private-fragment',
  ]) {
    useResponse({ artifactUrl: artifactUrlValue });
    await assert.rejects(
      () => artifactUrl(1, 2, 'job-1'),
      /clearfolio artifact-link response invalid/,
      `${artifactUrlValue} must not become browser redirect authority`,
    );
  }

  useResponse({ artifactUrl: 'https://clearfolio.example/file.pdf' });
  assert.equal(
    await artifactUrl(1, 2, 'job-1'),
    'https://clearfolio.example/file.pdf',
  );
});

test('valid submit response remains compatible with the bounded transport', async () => {
  useResponse({ jobId: ' job-2 ', status: 'PENDING' });
  assert.deepEqual(
    await submitJob(7, 9, { name: 'status.txt', mime: 'text/plain', bytes: Buffer.from('status') }),
    { jobId: 'job-2', status: 'PENDING' },
  );
  const { options } = calls.at(-1);
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok(options.body instanceof FormData);
});

test('non-success provider responses cancel unread bodies without parsing downstream payloads', async () => {
  let cancelledBodies = 0;
  const privatePayload = 'private downstream payload that must remain unread';
  responder = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(privatePayload));
      },
      cancel() {
        cancelledBodies += 1;
      },
    }),
    {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );

  const operations = [
    {
      run: () => submitJob(1, 2, { name: 'x.txt', mime: 'text/plain', bytes: Buffer.from('x') }),
      expected: 'clearfolio submit failed (503)',
    },
    {
      run: () => jobStatus(1, 2, 'job-1'),
      expected: 'clearfolio status failed (503)',
    },
    {
      run: () => artifactUrl(1, 2, 'job-1'),
      expected: 'clearfolio artifact-link failed (503)',
    },
  ];

  for (const [index, operation] of operations.entries()) {
    await assert.rejects(
      operation.run,
      (error) => {
        assert.equal(error.message, operation.expected);
        assert.doesNotMatch(error.message, /private downstream payload/);
        return true;
      },
    );
    assert.equal(cancelledBodies, index + 1, 'each rejected response body is explicitly cancelled');
  }

  responder = async () => new Response(null, { status: 503 });
  await assert.rejects(
    () => jobStatus(1, 2, 'job-1'),
    /clearfolio status failed \(503\)/,
  );
  assert.equal(cancelledBodies, 3, 'a response without a body needs no cancellation');

  responder = async () => new Response(
    new ReadableStream({
      cancel() {
        throw new Error('private cancel failure');
      },
    }),
    { status: 503 },
  );
  await assert.rejects(
    () => artifactUrl(1, 2, 'job-1'),
    (error) => {
      assert.equal(error.message, 'clearfolio artifact-link failed (503)');
      assert.doesNotMatch(error.message, /private cancel failure/);
      return true;
    },
  );
});
