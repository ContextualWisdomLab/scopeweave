import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';
const HMAC_SECRET = 'clearfolio-shared-secret-32-bytes!!';

/**
 * Read liveness and Clearfolio capability state from a fresh ScopeWeave process.
 *
 * Each probe uses a new Node process because Clearfolio configuration is bound at
 * module import time. The child replaces `fetch` with a throwing function so
 * readiness is proven from local configuration only and never turns liveness or
 * startup diagnostics into provider traffic.
 *
 * @param {Record<string,string>} overrides - Environment values for the child.
 * @returns {{health:{status:number,body:Record<string,unknown>},capability:Record<string,unknown>}} Probe result.
 */
function capabilityProbe(overrides = {}) {
  const env = { ...process.env };
  delete env.SCOPEWEAVE_DEV;
  delete env.CLEARFOLIO_URL;
  delete env.CLEARFOLIO_HMAC_SECRET;
  delete env.CLEARFOLIO_ARTIFACT_ORIGINS;
  Object.assign(env, overrides, {
    SCOPEWEAVE_DB: ':memory:',
    SCOPEWEAVE_JWT_SECRET: JWT_SECRET,
  });

  const script = `
    globalThis.fetch = async () => { throw new Error('readiness must not call a provider'); };
    const { clearfolioCapabilityStatus } = await import('./server/clearfolio.mjs?capability=' + Date.now());
    const { app } = await import('./server/app.mjs?capability-health=' + Date.now());
    const response = await app.request('/api/health');
    process.stdout.write(JSON.stringify({
      health: { status: response.status, body: await response.json() },
      capability: clearfolioCapabilityStatus(),
    }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

function expectLiveHealth(probe) {
  assert.deepEqual(probe.health, { status: 200, body: { ok: true } });
}

test('liveness stays healthy while unconfigured production reports Clearfolio unavailable', () => {
  const probe = capabilityProbe();
  expectLiveHealth(probe);
  assert.deepEqual(probe.capability, {
    ready: false,
    mode: 'unavailable',
    reason: 'clearfolio_not_configured',
    action: 'Set CLEARFOLIO_URL and CLEARFOLIO_HMAC_SECRET, or use SCOPEWEAVE_DEV=1 only for local development.',
  });
});

test('explicit development mock is visible without masquerading as production provider readiness', () => {
  const probe = capabilityProbe({ SCOPEWEAVE_DEV: '1' });
  expectLiveHealth(probe);
  assert.deepEqual(probe.capability, {
    ready: true,
    mode: 'development_mock',
    reason: null,
    action: 'Configure a Clearfolio provider before using this deployment for production document conversion.',
  });
});

test('valid production configuration reports provider readiness without provider traffic', () => {
  const probe = capabilityProbe({
    CLEARFOLIO_URL: 'https://clearfolio.example',
    CLEARFOLIO_HMAC_SECRET: HMAC_SECRET,
  });
  expectLiveHealth(probe);
  assert.deepEqual(probe.capability, {
    ready: true,
    mode: 'provider',
    reason: null,
    action: null,
  });
});

test('invalid production configuration degrades only Clearfolio capability and gives a safe next action', () => {
  const probe = capabilityProbe({
    CLEARFOLIO_URL: 'http://clearfolio.example',
    CLEARFOLIO_HMAC_SECRET: HMAC_SECRET,
  });
  expectLiveHealth(probe);
  assert.deepEqual(probe.capability, {
    ready: false,
    mode: 'unavailable',
    reason: 'clearfolio_transport_insecure',
    action: 'Set CLEARFOLIO_URL to a root HTTPS origin without credentials, path, query, or fragment.',
  });
});

test('invalid artifact-origin policy is readiness-visible before provider transport', () => {
  const probe = capabilityProbe({
    CLEARFOLIO_URL: 'https://clearfolio.example',
    CLEARFOLIO_HMAC_SECRET: HMAC_SECRET,
    CLEARFOLIO_ARTIFACT_ORIGINS: 'https://cdn.example/files',
  });
  expectLiveHealth(probe);
  assert.deepEqual(probe.capability, {
    ready: false,
    mode: 'unavailable',
    reason: 'clearfolio_artifact_origins_invalid',
    action: 'Set CLEARFOLIO_ARTIFACT_ORIGINS to comma-separated HTTPS origins without credentials, path, query, or fragment, or unset it.',
  });
});
