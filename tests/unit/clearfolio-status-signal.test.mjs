import test from 'node:test';
import assert from 'node:assert/strict';

const HMAC_SECRET = 'clearfolio-shared-secret-32-bytes!!';
process.env.CLEARFOLIO_URL = 'https://clearfolio.example';
process.env.CLEARFOLIO_HMAC_SECRET = HMAC_SECRET;
const originalFetch = globalThis.fetch;
let observedUrl;
let observedOptions;
let downstreamResponse;
let downstreamError;

globalThis.fetch = async (url, options = {}) => {
  observedUrl = String(url);
  observedOptions = options;
  if (downstreamError) throw downstreamError;
  return downstreamResponse();
};

const { artifactUrl, jobStatus, submitJob } = await import(
  '../../server/clearfolio.mjs?downstream-contract-test=1'
);

function setResponse({ status = 200, json }) {
  downstreamError = undefined;
  downstreamResponse = async () => {
    let body;
    try {
      body = JSON.stringify(await json());
    } catch {
      body = '{';
    }
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
}

function setNetworkError(error) {
  downstreamResponse = undefined;
  downstreamError = error;
}

async function expectSanitizedFailure(operation, expectedMessage, forbiddenPattern) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.message, expectedMessage);
    if (forbiddenPattern) assert.doesNotMatch(error.message, forbiddenPattern);
    return true;
  });
}

test.after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLEARFOLIO_URL;
  delete process.env.CLEARFOLIO_HMAC_SECRET;
  delete process.env.SCOPEWEAVE_DEV;
});

test('jobStatus enforces endpoint, signal, transport, HTTP, and status contracts', async () => {
  setResponse({ json: async () => ({ status: 'RUNNING' }) });
  const controller = new AbortController();
  const status = await jobStatus(1, 2, 'job-1', { signal: controller.signal });
  assert.equal(status, 'RUNNING');
  assert.equal(observedUrl, 'https://clearfolio.example/api/v1/convert/jobs/job-1');
  assert.ok(observedOptions.signal instanceof AbortSignal);
  assert.notEqual(observedOptions.signal, controller.signal, 'caller signal is composed with provider timeout');
  assert.equal(observedOptions.redirect, 'error');

  setNetworkError(new Error('connect ECONNREFUSED https://private-clearfolio.internal'));
  await expectSanitizedFailure(
    () => jobStatus(1, 2, 'job-1'),
    'clearfolio status unavailable',
    /private-clearfolio|ECONNREFUSED/,
  );

  setResponse({
    status: 503,
    json: async () => ({ message: 'sensitive downstream text' }),
  });
  await expectSanitizedFailure(
    () => jobStatus(1, 2, 'job-1'),
    'clearfolio status failed (503)',
    /sensitive downstream text/,
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
    { label: 'whitespace status', json: async () => ({ status: '   ' }) },
    { label: 'padded status', json: async () => ({ status: ' RUNNING ' }) },
    { label: 'unknown status', json: async () => ({ status: 'QUEUED' }) },
  ];

  for (const malformed of malformedPayloads) {
    setResponse({ json: malformed.json });
    await expectSanitizedFailure(
      () => jobStatus(1, 2, 'job-1'),
      'clearfolio status response invalid',
      /downstream parser detail/,
    );
  }
});

test('submitJob rejects transport details and malformed successful responses', async () => {
  const document = {
    name: 'status.txt',
    mime: 'text/plain',
    bytes: Buffer.from('status'),
  };

  setNetworkError(new Error('connect ECONNREFUSED https://private-clearfolio.internal'));
  await expectSanitizedFailure(
    () => submitJob(7, 9, document),
    'clearfolio submit unavailable',
    /private-clearfolio|ECONNREFUSED/,
  );

  setResponse({
    status: 422,
    json: async () => ({ message: 'tenant-internal rejection detail' }),
  });
  await expectSanitizedFailure(
    () => submitJob(7, 9, document),
    'clearfolio submit failed (422)',
    /tenant-internal rejection detail/,
  );
  assert.equal(observedUrl, 'https://clearfolio.example/api/v1/convert/jobs');
  assert.equal(observedOptions.method, 'POST');
  assert.equal(observedOptions.redirect, 'error');
  assert.ok(observedOptions.signal instanceof AbortSignal);
  assert.ok(observedOptions.body instanceof FormData);

  const malformedPayloads = [
    {
      label: 'unparseable JSON',
      json: async () => { throw new SyntaxError('private parser detail'); },
    },
    { label: 'null body', json: async () => null },
    { label: 'primitive body', json: async () => 'job-1' },
    { label: 'array body', json: async () => [{ jobId: 'job-1' }] },
    { label: 'missing jobId', json: async () => ({ status: 'PENDING' }) },
    { label: 'non-string jobId', json: async () => ({ jobId: 7 }) },
    { label: 'blank jobId', json: async () => ({ jobId: '   ' }) },
    { label: 'non-string status', json: async () => ({ jobId: 'job-1', status: 7 }) },
    { label: 'empty status', json: async () => ({ jobId: 'job-1', status: '' }) },
    { label: 'whitespace status', json: async () => ({ jobId: 'job-1', status: '   ' }) },
    { label: 'padded status', json: async () => ({ jobId: 'job-1', status: ' RUNNING ' }) },
    { label: 'unknown status', json: async () => ({ jobId: 'job-1', status: 'QUEUED' }) },
  ];

  for (const malformed of malformedPayloads) {
    setResponse({ json: malformed.json });
    await expectSanitizedFailure(
      () => submitJob(7, 9, document),
      'clearfolio submit response invalid',
      /private parser detail/,
    );
  }

  setResponse({ json: async () => ({ jobId: '  job-2  ' }) });
  assert.deepEqual(await submitJob(7, 9, document), {
    jobId: 'job-2',
    status: 'PENDING',
  });

  setResponse({ json: async () => ({ jobId: 'job-3', status: 'RUNNING' }) });
  assert.deepEqual(await submitJob(7, 9, document), {
    jobId: 'job-3',
    status: 'RUNNING',
  });
});

test('artifactUrl validates links and never exposes transport or response text', async () => {
  setNetworkError(new Error('getaddrinfo ENOTFOUND private-clearfolio.internal'));
  await expectSanitizedFailure(
    () => artifactUrl(4, 5, 'job-1'),
    'clearfolio artifact-link unavailable',
    /private-clearfolio|ENOTFOUND/,
  );

  setResponse({
    status: 502,
    json: async () => ({ message: 'signed URL service secret detail' }),
  });
  await expectSanitizedFailure(
    () => artifactUrl(4, 5, 'job-1'),
    'clearfolio artifact-link failed (502)',
    /signed URL service secret detail/,
  );
  assert.equal(
    observedUrl,
    'https://clearfolio.example/api/v1/viewer/job-1/artifact-links',
  );
  assert.equal(observedOptions.method, 'POST');
  assert.equal(observedOptions.redirect, 'error');
  assert.ok(observedOptions.signal instanceof AbortSignal);

  const malformedPayloads = [
    {
      label: 'unparseable JSON',
      json: async () => { throw new SyntaxError('private artifact parser detail'); },
    },
    { label: 'null body', json: async () => null },
    { label: 'primitive body', json: async () => '/signed/file.pdf' },
    { label: 'array body', json: async () => [{ url: '/signed/file.pdf' }] },
    { label: 'missing link', json: async () => ({}) },
    { label: 'non-string link', json: async () => ({ artifactUrl: 42 }) },
    { label: 'empty link', json: async () => ({ artifactUrl: '' }) },
    { label: 'malformed URL', json: async () => ({ artifactUrl: 'http://[' }) },
    { label: 'unsupported URL scheme', json: async () => ({ artifactUrl: 'javascript:alert(1)' }) },
    { label: 'HTTPS downgrade', json: async () => ({ artifactUrl: 'http://cdn.example/file.pdf' }) },
    { label: 'foreign HTTPS origin', json: async () => ({ artifactUrl: 'https://cdn.example/file.pdf' }) },
    { label: 'protocol-relative foreign origin', json: async () => ({ artifactUrl: '//evil.example/file.pdf' }) },
    { label: 'credentialed same origin', json: async () => ({ artifactUrl: 'https://user@clearfolio.example/file.pdf' }) },
    { label: 'fragmented same origin', json: async () => ({ artifactUrl: 'https://clearfolio.example/file.pdf#viewer-state' }) },
  ];

  for (const malformed of malformedPayloads) {
    setResponse({ json: malformed.json });
    await expectSanitizedFailure(
      () => artifactUrl(4, 5, 'job-1'),
      'clearfolio artifact-link response invalid',
      /private artifact parser detail/,
    );
  }

  setResponse({ json: async () => ({ artifactUrl: '/signed/file.pdf' }) });
  assert.equal(
    await artifactUrl(4, 5, 'job-1'),
    'https://clearfolio.example/signed/file.pdf',
  );

  setResponse({ json: async () => ({
    signedUrl: 'https://clearfolio.example/file.pdf?artifactToken=same%20origin',
  }) });
  assert.equal(
    await artifactUrl(4, 5, 'job-1'),
    'https://clearfolio.example/viewer/job-1?artifactToken=same%20origin',
    'same-origin artifact tokens may be translated into the trusted viewer route',
  );

  setResponse({
    json: async () => ({
      signedUrl: 'https://cdn.example/file.pdf?artifactToken=token%20value',
    }),
  });
  await expectSanitizedFailure(
    () => artifactUrl(4, 5, 'job-1'),
    'clearfolio artifact-link response invalid',
  );
});

test('artifactUrl permits HTTP only for explicit loopback development', async () => {
  process.env.SCOPEWEAVE_DEV = '1';
  process.env.CLEARFOLIO_URL = 'http://127.0.0.1:8080';
  process.env.CLEARFOLIO_HMAC_SECRET = HMAC_SECRET;
  try {
    const { artifactUrl: httpArtifactUrl } = await import(
      '../../server/clearfolio.mjs?http-artifact-contract-test=1'
    );
    setResponse({ json: async () => ({ artifactUrl: 'http://127.0.0.1:8080/file.pdf' }) });
    assert.equal(
      await httpArtifactUrl(4, 5, 'job-http'),
      'http://127.0.0.1:8080/file.pdf',
    );
  } finally {
    process.env.CLEARFOLIO_URL = 'https://clearfolio.example';
    delete process.env.SCOPEWEAVE_DEV;
  }
});
