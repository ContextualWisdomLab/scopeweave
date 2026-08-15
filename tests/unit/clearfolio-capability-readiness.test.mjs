import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';
const HMAC_SECRET = 'clearfolio-shared-secret-32-bytes!!';

/**
 * Ask a fresh ScopeWeave process for `/api/health` under one Clearfolio configuration.
 *
 * Each probe uses a new Node process because Clearfolio configuration is bound at
 * module import time. The child replaces `fetch` with a throwing function so the
 * health contract proves capability readiness from local configuration only and
 * never turns a liveness request into provider traffic.
 *
 * @param {Record<string,string>} overrides - Environment values for the child.
 * @returns {{status:number,body:Record<string,unknown>}} Parsed health response.
 */
function healthProbe(overrides = {}) {
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
    globalThis.fetch = async () => { throw new Error('health must not call a provider'); };
    const { app } = await import('./server/app.mjs?capability-health=' + Date.now());
    const response = await app.request('/api/health');
    process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

test('health stays live while unconfigured production reports Clearfolio unavailable', () => {
  assert.deepEqual(healthProbe(), {
    status: 200,
    body: {
      ok: true,
      capabilities: {
        clearfolio: {
          ready: false,
          mode: 'unavailable',
          reason: 'clearfolio_not_configured',
          action: 'Set CLEARFOLIO_URL and CLEARFOLIO_HMAC_SECRET, or use SCOPEWEAVE_DEV=1 only for local development.',
        },
      },
    },
  });
});

test('explicit development mock is visible without masquerading as production provider readiness', () => {
  assert.deepEqual(healthProbe({ SCOPEWEAVE_DEV: '1' }), {
    status: 200,
    body: {
      ok: true,
      capabilities: {
        clearfolio: {
          ready: true,
          mode: 'development_mock',
          reason: null,
          action: 'Configure a Clearfolio provider before using this deployment for production document conversion.',
        },
      },
    },
  });
});

test('valid production configuration reports provider readiness without provider traffic', () => {
  assert.deepEqual(healthProbe({
    CLEARFOLIO_URL: 'https://clearfolio.example',
    CLEARFOLIO_HMAC_SECRET: HMAC_SECRET,
  }), {
    status: 200,
    body: {
      ok: true,
      capabilities: {
        clearfolio: {
          ready: true,
          mode: 'provider',
          reason: null,
          action: null,
        },
      },
    },
  });
});

test('invalid production configuration degrades only Clearfolio capability and gives a safe next action', () => {
  assert.deepEqual(healthProbe({
    CLEARFOLIO_URL: 'http://clearfolio.example',
    CLEARFOLIO_HMAC_SECRET: HMAC_SECRET,
  }), {
    status: 200,
    body: {
      ok: true,
      capabilities: {
        clearfolio: {
          ready: false,
          mode: 'unavailable',
          reason: 'clearfolio_transport_insecure',
          action: 'Set CLEARFOLIO_URL to a root HTTPS origin without credentials, path, query, or fragment.',
        },
      },
    },
  });
});
