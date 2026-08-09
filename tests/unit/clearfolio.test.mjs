import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  globalThis.fetch = ORIGINAL_FETCH;
}

async function freshModule(label) {
  return import(`../../server/clearfolio.mjs?test=${label}-${Date.now()}-${Math.random()}`);
}

try {
  delete process.env.CLEARFOLIO_URL;
  delete process.env.CLEARFOLIO_HMAC_SECRET;
  delete process.env.SCOPEWEAVE_DEV;
  const productionUnconfigured = await freshModule('unconfigured');
  assert.equal(productionUnconfigured.clearfolioMock, false);
  await assert.rejects(
    productionUnconfigured.submitJob(1, 2, {
      name: 'report.pdf',
      mime: 'application/pdf',
      bytes: new Uint8Array([1]),
    }),
    (error) => error.code === 'clearfolio_not_configured',
    'unconfigured production must not synthesize a successful conversion',
  );

  process.env.SCOPEWEAVE_DEV = '1';
  const development = await freshModule('development');
  assert.equal(development.clearfolioMock, true);
  const developmentJob = await development.submitJob(1, 2, {
    name: 'report.pdf',
    mime: 'application/pdf',
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.equal(developmentJob.status, 'SUCCEEDED');
  assert.ok(development.mockArtifact(developmentJob.jobId));
  assert.equal(await development.jobStatus(1, 2, developmentJob.jobId), 'SUCCEEDED');
  assert.equal(
    await development.artifactUrl(1, 2, developmentJob.jobId),
    `/api/mock-clearfolio/${developmentJob.jobId}`,
  );

  delete process.env.SCOPEWEAVE_DEV;
  process.env.CLEARFOLIO_URL = 'https://clearfolio.example';
  delete process.env.CLEARFOLIO_HMAC_SECRET;
  const unsignedProduction = await freshModule('unsigned');
  await assert.rejects(
    unsignedProduction.jobStatus(1, 2, 'job-1'),
    (error) => error.code === 'clearfolio_hmac_secret_missing',
  );

  process.env.CLEARFOLIO_HMAC_SECRET = 'tenant-claim-secret';
  const production = await freshModule('configured');
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/api/v1/convert/jobs')) {
      return new Response(JSON.stringify({ jobId: 'job-1', status: 'PENDING' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/v1/convert/jobs/job-1')) {
      return new Response(JSON.stringify({ status: 'SUCCEEDED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      artifactUrl: 'https://clearfolio.example/artifacts/job-1?artifactToken=token-1',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const submitted = await production.submitJob(1, 2, {
    name: 'report.pdf',
    mime: 'application/pdf',
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(submitted, { jobId: 'job-1', status: 'PENDING' });
  assert.equal(await production.jobStatus(1, 2, 'job-1'), 'SUCCEEDED');
  assert.equal(
    await production.artifactUrl(1, 2, 'job-1'),
    'https://clearfolio.example/viewer/job-1?artifactToken=token-1',
  );

  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Clearfolio-Tenant-Id'], 'sw-org-1');
  assert.equal(calls[0].init.headers['X-Clearfolio-Subject-Id'], 'sw-user-2');
  assert.ok(calls[0].init.headers['X-Clearfolio-Claims-Signature']);
  assert.ok(calls.every((call) => call.init.signal instanceof AbortSignal));

  const sig = production.signClaims(
    'sw-org-1',
    'sw-user-2',
    'job:create,job:read',
    '1750000000',
    's3cret',
  );
  const expected = createHmac('sha256', 's3cret')
    .update('sw-org-1\nsw-user-2\njob:create,job:read\n1750000000')
    .digest('base64url');
  assert.equal(sig, expected, 'canonical payload joined with newline');
  assert.ok(!sig.includes('='), 'base64url without padding');
  assert.notEqual(
    sig,
    production.signClaims(
      'sw-org-1',
      'sw-user-2',
      'job:create,job:read',
      '1750000001',
      's3cret',
    ),
    'issuedAt-sensitive',
  );

  await assert.rejects(
    production.submitJob(1, 2, {
      name: 'empty.pdf',
      mime: 'application/pdf',
      bytes: new Uint8Array(),
    }),
    (error) => error.code === 'clearfolio_document_size_invalid',
  );

  globalThis.fetch = async () => new Response('not-json', { status: 502 });
  await assert.rejects(
    production.jobStatus(1, 2, 'job-1'),
    (error) => error.code === 'clearfolio_response_invalid',
  );

  globalThis.fetch = async () => new Response(JSON.stringify({
    artifactUrl: 'http://attacker.example/artifact',
  }), { status: 200 });
  await assert.rejects(
    production.artifactUrl(1, 2, 'job-1'),
    (error) => error.code === 'clearfolio_artifact_url_insecure',
  );
} finally {
  restoreEnvironment();
}

console.log('✓ clearfolio production boundary tests passed');
