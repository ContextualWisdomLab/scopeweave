import test from 'node:test';
import assert from 'node:assert/strict';

const HMAC_SECRET = 'clearfolio-shared-secret-32-bytes!!';
const originalFetch = globalThis.fetch;
let importSequence = 0;
let fetchCalls = 0;
let artifactPayload = { artifactUrl: 'https://clearfolio.example/file.pdf' };

globalThis.fetch = async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify(artifactPayload), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};

async function loadAdapter(artifactOrigins) {
  process.env.CLEARFOLIO_URL = 'https://clearfolio.example';
  process.env.CLEARFOLIO_HMAC_SECRET = HMAC_SECRET;
  delete process.env.SCOPEWEAVE_DEV;
  if (artifactOrigins === undefined) delete process.env.CLEARFOLIO_ARTIFACT_ORIGINS;
  else process.env.CLEARFOLIO_ARTIFACT_ORIGINS = artifactOrigins;
  importSequence += 1;
  return import(`../../server/clearfolio.mjs?artifact-origin-policy=${importSequence}`);
}

async function resolveArtifact(link, artifactOrigins) {
  artifactPayload = { artifactUrl: link };
  const { artifactUrl } = await loadAdapter(artifactOrigins);
  return artifactUrl(4, 5, 'job-1');
}

test.after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLEARFOLIO_URL;
  delete process.env.CLEARFOLIO_HMAC_SECRET;
  delete process.env.CLEARFOLIO_ARTIFACT_ORIGINS;
  delete process.env.SCOPEWEAVE_DEV;
});

test('artifact URLs default to the configured Clearfolio origin', async () => {
  await assert.rejects(
    () => resolveArtifact('https://cdn.example/file.pdf', undefined),
    /clearfolio artifact-link response invalid/,
  );
  assert.equal(
    await resolveArtifact('/signed/file.pdf', undefined),
    'https://clearfolio.example/signed/file.pdf',
  );
});

test('explicit HTTPS artifact origins are exact scheme-host-port allowlist entries', async () => {
  assert.equal(
    await resolveArtifact('https://cdn.example/file.pdf', ' https://cdn.example '),
    'https://cdn.example/file.pdf',
  );
  assert.equal(
    await resolveArtifact(
      'https://cdn.example/file.pdf?artifactToken=remote%20token',
      'https://cdn.example',
    ),
    'https://cdn.example/file.pdf?artifactToken=remote%20token',
    'an allowlisted cross-origin token remains bound to the returned origin',
  );
  await assert.rejects(
    () => resolveArtifact('https://cdn.example/file.pdf', 'https://cdn.example:8443'),
    /clearfolio artifact-link response invalid/,
    'an allowlist entry with a different port is a different origin',
  );
});

test('artifact links reject credentials and fragments even on trusted origins', async () => {
  for (const link of [
    'https://user:password@clearfolio.example/file.pdf',
    'https://clearfolio.example/file.pdf#secret-fragment',
    'https://user:password@cdn.example/file.pdf',
    'https://cdn.example/file.pdf#secret-fragment',
  ]) {
    await assert.rejects(
      () => resolveArtifact(link, 'https://cdn.example'),
      /clearfolio artifact-link response invalid/,
    );
  }
});

test('artifact origin configuration fails closed before provider transport', async () => {
  const invalidConfigurations = [
    'http://cdn.example',
    'https://user:password@cdn.example',
    'https://cdn.example/path',
    'https://cdn.example?query=1',
    'https://cdn.example#fragment',
    'not a URL',
    'https://cdn.example,',
  ];

  for (const artifactOrigins of invalidConfigurations) {
    const before = fetchCalls;
    artifactPayload = { artifactUrl: 'https://cdn.example/file.pdf' };
    const { artifactUrl } = await loadAdapter(artifactOrigins);
    await assert.rejects(
      () => artifactUrl(4, 5, 'job-1'),
      (error) => {
        assert.equal(error.code, 'clearfolio_artifact_origins_invalid');
        return true;
      },
    );
    assert.equal(fetchCalls, before, `invalid allowlist ${artifactOrigins} never reaches provider transport`);
  }
});
