import test from 'node:test';
import assert from 'node:assert/strict';

test('Clearfolio mock adapter preserves artifacts and local status semantics', async () => {
  delete process.env.CLEARFOLIO_URL;
  delete process.env.CLEARFOLIO_HMAC_SECRET;
  const mock = await import('../../server/clearfolio.mjs?mock-adapter-contract-test=1');

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
});

test('Clearfolio tenant claim headers use the documented HMAC contract', async () => {
  process.env.CLEARFOLIO_URL = 'https://clearfolio.example/';
  process.env.CLEARFOLIO_HMAC_SECRET = 'clearfolio-shared-secret';
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
    const signed = await import('../../server/clearfolio.mjs?hmac-header-contract-test=1');
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
        'clearfolio-shared-secret',
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
