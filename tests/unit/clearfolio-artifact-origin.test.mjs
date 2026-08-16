import test from 'node:test';
import assert from 'node:assert/strict';

const HMAC_SECRET = 'clearfolio-shared-secret-32-bytes!!';

async function freshModule(label) {
  return import(`../../server/clearfolio.mjs?artifact-origin-${label}-${Date.now()}-${Math.random()}`);
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function withArtifactLink(moduleName, link, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ artifactUrl: link });
  try {
    const { artifactUrl } = await freshModule(moduleName);
    return await run(artifactUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function configureProductionProvider() {
  delete process.env.SCOPEWEAVE_DEV;
  process.env.CLEARFOLIO_URL = 'https://clearfolio.example';
  process.env.CLEARFOLIO_HMAC_SECRET = HMAC_SECRET;
}

test.after(() => {
  delete process.env.CLEARFOLIO_URL;
  delete process.env.CLEARFOLIO_HMAC_SECRET;
  delete process.env.CLEARFOLIO_ARTIFACT_ORIGINS;
  delete process.env.SCOPEWEAVE_DEV;
});

test('tokenless cross-origin artifact links fail closed without a reviewed origin allowlist', async () => {
  configureProductionProvider();
  delete process.env.CLEARFOLIO_ARTIFACT_ORIGINS;
  await withArtifactLink('unlisted-cdn', 'https://cdn.example/file.pdf', async (artifactUrl) => {
    await assert.rejects(
      () => artifactUrl(4, 5, 'job-1'),
      /clearfolio artifact-link response invalid/,
    );
  });
});

test('artifact links with credentials or fragments are rejected before any redirect target is returned', async () => {
  configureProductionProvider();
  process.env.CLEARFOLIO_ARTIFACT_ORIGINS = 'https://cdn.example';
  for (const [label, link] of [
    ['userinfo', 'https://user:pass@cdn.example/file.pdf'],
    ['fragment', 'https://cdn.example/file.pdf#phish'],
  ]) {
    await withArtifactLink(label, link, async (artifactUrl) => {
      await assert.rejects(
        () => artifactUrl(4, 5, 'job-1'),
        /clearfolio artifact-link response invalid/,
        `${label} must never become an attachment-view redirect`,
      );
    });
  }
});

test('same-origin tokenless and token-bearing viewer links remain usable without an allowlist', async () => {
  configureProductionProvider();
  delete process.env.CLEARFOLIO_ARTIFACT_ORIGINS;
  await withArtifactLink('same-origin-relative', '/signed/file.pdf', async (artifactUrl) => {
    assert.equal(await artifactUrl(4, 5, 'job-1'), 'https://clearfolio.example/signed/file.pdf');
  });
  await withArtifactLink(
    'same-origin-token',
    'https://clearfolio.example/file.pdf?artifactToken=same%20origin',
    async (artifactUrl) => {
      assert.equal(
        await artifactUrl(4, 5, 'job-1'),
        'https://clearfolio.example/viewer/job-1?artifactToken=same%20origin',
      );
    },
  );
});

test('reviewed CDN origins may be returned only when listed and never transplanted into the viewer', async () => {
  configureProductionProvider();
  process.env.CLEARFOLIO_ARTIFACT_ORIGINS = 'https://cdn.example,, https://cdn.example, https://files.example:8443';
  await withArtifactLink('allowlisted-cdn', 'https://cdn.example/file.pdf', async (artifactUrl) => {
    assert.equal(await artifactUrl(4, 5, 'job-1'), 'https://cdn.example/file.pdf');
  });
  await withArtifactLink(
    'allowlisted-cdn-token',
    'https://cdn.example/file.pdf?artifactToken=cdn-token',
    async (artifactUrl) => {
      assert.equal(
        await artifactUrl(4, 5, 'job-1'),
        'https://cdn.example/file.pdf?artifactToken=cdn-token',
        'an allowlisted CDN token stays on that origin instead of moving into the Clearfolio viewer',
      );
    },
  );
  await withArtifactLink(
    'allowlisted-port',
    'https://files.example:8443/export.pdf',
    async (artifactUrl) => {
      assert.equal(await artifactUrl(4, 5, 'job-1'), 'https://files.example:8443/export.pdf');
    },
  );
  await withArtifactLink(
    'unlisted-other-cdn',
    'https://other-cdn.example/file.pdf',
    async (artifactUrl) => {
      await assert.rejects(
        () => artifactUrl(4, 5, 'job-1'),
        /clearfolio artifact-link response invalid/,
      );
    },
  );
});

test('explicit development mode may allowlist a second loopback HTTP origin', async () => {
  process.env.SCOPEWEAVE_DEV = '1';
  process.env.CLEARFOLIO_URL = 'http://127.0.0.1:8080';
  process.env.CLEARFOLIO_HMAC_SECRET = HMAC_SECRET;
  process.env.CLEARFOLIO_ARTIFACT_ORIGINS = 'http://127.0.0.1:9090';
  await withArtifactLink(
    'dev-loopback-allowlist',
    'http://127.0.0.1:9090/file.pdf',
    async (artifactUrl) => {
      assert.equal(await artifactUrl(4, 5, 'job-http'), 'http://127.0.0.1:9090/file.pdf');
    },
  );
});

test('CLEARFOLIO_ARTIFACT_ORIGINS rejects unsafe or ambiguous origin entries before returning a view link', async () => {
  configureProductionProvider();
  const cases = [
    ['https://user:pass@cdn.example', 'clearfolio_artifact_origins_invalid'],
    ['https://cdn.example/path', 'clearfolio_artifact_origins_invalid'],
    ['https://cdn.example?x=1', 'clearfolio_artifact_origins_invalid'],
    ['https://cdn.example#frag', 'clearfolio_artifact_origins_invalid'],
    ['http://cdn.example', 'clearfolio_artifact_origins_invalid'],
    ['ftp://cdn.example', 'clearfolio_artifact_origins_invalid'],
    ['not-a-url', 'clearfolio_artifact_origins_invalid'],
  ];
  for (const [origins, code] of cases) {
    process.env.CLEARFOLIO_ARTIFACT_ORIGINS = origins;
    await withArtifactLink(`invalid-allowlist-${code}`, 'https://cdn.example/file.pdf', async (artifactUrl) => {
      await assert.rejects(
        () => artifactUrl(4, 5, 'job-1'),
        (error) => error.code === code,
        `${origins} should fail closed with ${code}`,
      );
    });
  }
});
