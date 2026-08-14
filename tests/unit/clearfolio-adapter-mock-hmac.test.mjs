import test from 'node:test';
import assert from 'node:assert/strict';

const HMAC_SECRET = 'clearfolio-shared-secret-32-bytes!!';

async function freshModule(label) {
  return import(`../../server/clearfolio.mjs?${label}-${Date.now()}-${Math.random()}`);
}

test('unconfigured production fails closed instead of creating fake conversions', async () => {
  delete process.env.SCOPEWEAVE_DEV;
  delete process.env.CLEARFOLIO_URL;
  delete process.env.CLEARFOLIO_HMAC_SECRET;
  const production = await freshModule('unconfigured-production');

  assert.equal(production.clearfolioMock, false);
  assert.equal(production.mockArtifact('missing-job'), null);
  for (const operation of [
    () => production.submitJob(11, 12, { name: 'mock.txt', mime: 'text/plain', bytes: Buffer.from('x') }),
    () => production.jobStatus(11, 12, 'job-1'),
    () => production.artifactUrl(11, 12, 'job-1'),
  ]) {
    await assert.rejects(operation, (error) => error.code === 'clearfolio_not_configured');
  }
});

test('Clearfolio mock adapter exists only in explicit development mode', async () => {
  process.env.SCOPEWEAVE_DEV = '1';
  delete process.env.CLEARFOLIO_URL;
  delete process.env.CLEARFOLIO_HMAC_SECRET;
  const mock = await freshModule('mock-adapter-contract');

  assert.equal(mock.clearfolioMock, true);
  assert.equal(mock.mockArtifact('missing-job'), null);

  const bytes = Buffer.from('mock document');
  const submitted = await mock.submitJob(11, 12, {
    name: 'mock.txt',
    mime: '',
    bytes,
  });
  assert.match(submitted.jobId, /^mockcf-\d+$/);
  assert.equal(submitted.status, 'SUCCEEDED');
  assert.deepEqual(mock.mockArtifact(submitted.jobId), {
    name: 'mock.txt',
    mime: '',
    bytes,
  });
  assert.equal(await mock.jobStatus(11, 12, submitted.jobId), 'SUCCEEDED');
  assert.equal(await mock.jobStatus(11, 12, 'missing-job'), 'FAILED');
  assert.equal(
    await mock.artifactUrl(11, 12, 'job/with space'),
    '/api/mock-clearfolio/job%2Fwith%20space',
  );
  delete process.env.SCOPEWEAVE_DEV;
});

test('production URL and HMAC configuration rejects ambiguous or unsafe input', async () => {
  delete process.env.SCOPEWEAVE_DEV;
  const cases = [
    ['not a url', HMAC_SECRET, 'clearfolio_url_invalid'],
    ['ftp://clearfolio.example', HMAC_SECRET, 'clearfolio_url_invalid'],
    ['http://clearfolio.example', HMAC_SECRET, 'clearfolio_transport_insecure'],
    ['https://user:pass@clearfolio.example', HMAC_SECRET, 'clearfolio_url_credentials_forbidden'],
    ['https://clearfolio.example?tenant=x', HMAC_SECRET, 'clearfolio_url_query_forbidden'],
    ['https://clearfolio.example#fragment', HMAC_SECRET, 'clearfolio_url_fragment_forbidden'],
    ['https://clearfolio.example/base', HMAC_SECRET, 'clearfolio_url_path_forbidden'],
    ['https://clearfolio.example', 'short-secret', 'clearfolio_hmac_secret_invalid'],
    [
      'https://clearfolio.example',
      `${'a'.repeat(31)} ${' '.repeat(32)}`,
      'clearfolio_hmac_secret_invalid',
    ],
  ];

  for (const [url, secret, code] of cases) {
    process.env.CLEARFOLIO_URL = url;
    process.env.CLEARFOLIO_HMAC_SECRET = secret;
    const configured = await freshModule(`invalid-${code}`);
    await assert.rejects(
      () => configured.jobStatus(1, 2, 'job-1'),
      (error) => error.code === code,
      `${url} should fail with ${code}`,
    );
  }

  process.env.SCOPEWEAVE_DEV = '1';
  process.env.CLEARFOLIO_URL = 'http://127.0.0.1:8080';
  process.env.CLEARFOLIO_HMAC_SECRET = HMAC_SECRET;
  const loopback = await freshModule('development-loopback-http');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'RUNNING' }),
  });
  try {
    assert.equal(await loopback.jobStatus(1, 2, 'job-1'), 'RUNNING');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SCOPEWEAVE_DEV;
    delete process.env.CLEARFOLIO_URL;
    delete process.env.CLEARFOLIO_HMAC_SECRET;
  }
});

test('Clearfolio tenant claim headers use the documented HMAC contract', async () => {
  delete process.env.SCOPEWEAVE_DEV;
  process.env.CLEARFOLIO_URL = 'https://clearfolio.example/';
  process.env.CLEARFOLIO_HMAC_SECRET = HMAC_SECRET;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let observedUrl;
  let observedOptions;
  Date.now = () => 1_750_000_000_000;
  globalThis.fetch = async (url, options) => {
    observedUrl = String(url);
    observedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'RUNNING' }),
    };
  };

  try {
    const signed = await freshModule('hmac-header-contract');
    assert.equal(signed.clearfolioMock, false);
    assert.equal(await signed.jobStatus(21, 34, 'signed-job'), 'RUNNING');
    assert.equal(
      observedUrl,
      'https://clearfolio.example/api/v1/convert/jobs/signed-job',
    );

    const issuedAt = '1750000000';
    assert.equal(observedOptions.headers['X-Clearfolio-Tenant-Id'], 'sw-org-21');
    assert.equal(observedOptions.headers['X-Clearfolio-Subject-Id'], 'sw-user-34');
    assert.equal(
      observedOptions.headers['X-Clearfolio-Permissions'],
      'job:create,job:read,viewer:read,artifact-link:create',
    );
    assert.equal(observedOptions.headers['X-Clearfolio-Claims-Issued-At'], issuedAt);
    assert.equal(
      observedOptions.headers['X-Clearfolio-Claims-Signature'],
      signed.signClaims(
        'sw-org-21',
        'sw-user-34',
        'job:create,job:read,viewer:read,artifact-link:create',
        issuedAt,
        HMAC_SECRET,
      ),
    );
    assert.doesNotMatch(
      observedOptions.headers['X-Clearfolio-Claims-Signature'],
      /=/,
    );
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    delete process.env.CLEARFOLIO_URL;
    delete process.env.CLEARFOLIO_HMAC_SECRET;
  }
});
