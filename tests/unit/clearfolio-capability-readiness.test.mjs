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
 * @param {{authenticate?:boolean,upload?:boolean}} [options] - Optional authenticated surfaces to exercise.
 * @returns {{health:{status:number,body:Record<string,unknown>},capability:Record<string,unknown>,anonymousCapabilities:{status:number,body:Record<string,unknown>},capabilities:{status:number,body:Record<string,unknown>}|null,upload:{status:number,body:Record<string,unknown>}|null}} Probe result.
 */
function capabilityProbe(overrides = {}, options = {}) {
  const env = { ...process.env };
  delete env.SCOPEWEAVE_DEV;
  delete env.CLEARFOLIO_URL;
  delete env.CLEARFOLIO_HMAC_SECRET;
  delete env.CLEARFOLIO_ARTIFACT_ORIGINS;
  Object.assign(env, overrides, {
    SCOPEWEAVE_DB: ':memory:',
    SCOPEWEAVE_JWT_SECRET: JWT_SECRET,
  });
  const authenticate = options.authenticate === true;
  const upload = options.upload === true;

  const script = `
    globalThis.fetch = async () => { throw new Error('readiness must not call a provider'); };
    const { clearfolioCapabilityStatus } = await import('./server/clearfolio.mjs?capability=' + Date.now());
    const { app } = await import('./server/app.mjs?capability-health=' + Date.now());
    const healthResponse = await app.request('/api/health');
    const anonymousResponse = await app.request('/api/capabilities');
    let capabilities = null;
    let uploadResult = null;
    if (${authenticate}) {
      const signup = await app.request('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'capability-' + Date.now() + '@scopeweave.test',
          password: 'password123',
          name: 'Capability',
        }),
      });
      const token = (await signup.json()).token;
      const capabilityResponse = await app.request('/api/capabilities', {
        headers: { authorization: 'Bearer ' + token },
      });
      capabilities = { status: capabilityResponse.status, body: await capabilityResponse.json() };
      if (${upload}) {
        const projectResponse = await app.request('/api/projects', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Capability Project' }),
        });
        const projectId = (await projectResponse.json()).id;
        const form = new FormData();
        form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');
        const uploadResponse = await app.request('/api/projects/' + projectId + '/attachments', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token },
          body: form,
        });
        uploadResult = { status: uploadResponse.status, body: await uploadResponse.json() };
      }
    }
    process.stdout.write(JSON.stringify({
      health: { status: healthResponse.status, body: await healthResponse.json() },
      capability: clearfolioCapabilityStatus(),
      anonymousCapabilities: { status: anonymousResponse.status, body: await anonymousResponse.json() },
      capabilities,
      upload: uploadResult,
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

/**
 * Exercise an already-persisted pending attachment while Clearfolio is unready.
 *
 * The child creates the attachment directly in the same in-memory database used
 * by the app so the view route is tested without ever submitting provider work.
 * Provider fetch is replaced with a throwing function to prove the readiness
 * short-circuit happens before artifact transport.
 *
 * @returns {{status:number,body:Record<string,unknown>}} View response.
 */
function pendingAttachmentViewProbe() {
  const env = { ...process.env };
  delete env.SCOPEWEAVE_DEV;
  delete env.CLEARFOLIO_URL;
  delete env.CLEARFOLIO_HMAC_SECRET;
  delete env.CLEARFOLIO_ARTIFACT_ORIGINS;
  Object.assign(env, {
    SCOPEWEAVE_DB: ':memory:',
    SCOPEWEAVE_JWT_SECRET: JWT_SECRET,
  });

  const script = `
    globalThis.fetch = async () => { throw new Error('unready view must not call a provider'); };
    const { app } = await import('./server/app.mjs?pending-view=' + Date.now());
    const { db } = await import('./server/db.mjs');
    const email = 'pending-view-' + Date.now() + '@scopeweave.test';
    const signup = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', name: 'Pending View' }),
    });
    const token = (await signup.json()).token;
    const projectResponse = await app.request('/api/projects', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Pending View Project' }),
    });
    const projectId = (await projectResponse.json()).id;
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    const inserted = db.prepare(
      "INSERT INTO attachments(project_id,name,mime,size,job_id,status,created_by) VALUES(?,?,?,?,?,?,?)",
    ).run(projectId, 'pending.txt', 'text/plain', 7, 'pending-job', 'PENDING', userId);
    const attachmentId = Number(inserted.lastInsertRowid);
    const response = await app.request(
      '/api/projects/' + projectId + '/attachments/' + attachmentId + '/view',
      { headers: { authorization: 'Bearer ' + token } },
    );
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

test('weak HMAC is readiness-visible with a secret-free next action', () => {
  const probe = capabilityProbe({
    CLEARFOLIO_URL: 'https://clearfolio.example',
    CLEARFOLIO_HMAC_SECRET: 'too-short',
  });
  expectLiveHealth(probe);
  assert.deepEqual(probe.capability, {
    ready: false,
    mode: 'unavailable',
    reason: 'clearfolio_hmac_secret_invalid',
    action: 'Set CLEARFOLIO_HMAC_SECRET to at least 32 non-whitespace characters.',
  });
});

test('authenticated capability query stays local and does not change liveness', () => {
  const probe = capabilityProbe({}, { authenticate: true });
  expectLiveHealth(probe);
  assert.equal(probe.anonymousCapabilities.status, 401);
  assert.deepEqual(probe.anonymousCapabilities.body, { error: 'unauthorized' });
  assert.equal(probe.capabilities.status, 200);
  assert.deepEqual(probe.capabilities.body, {
    capabilities: {
      clearfolio: {
        ready: false,
        mode: 'unavailable',
        reason: 'clearfolio_not_configured',
        action: 'Set CLEARFOLIO_URL and CLEARFOLIO_HMAC_SECRET, or use SCOPEWEAVE_DEV=1 only for local development.',
      },
    },
  });
});

test('unconfigured production rejects attachment upload before provider traffic', () => {
  const probe = capabilityProbe({}, { authenticate: true, upload: true });
  expectLiveHealth(probe);
  assert.equal(probe.upload.status, 503);
  assert.deepEqual(probe.upload.body, {
    error: 'Set CLEARFOLIO_URL and CLEARFOLIO_HMAC_SECRET, or use SCOPEWEAVE_DEV=1 only for local development.',
    capability: 'clearfolio',
    ready: false,
    mode: 'unavailable',
    reason: 'clearfolio_not_configured',
    action: 'Set CLEARFOLIO_URL and CLEARFOLIO_HMAC_SECRET, or use SCOPEWEAVE_DEV=1 only for local development.',
  });
});

test('unconfigured production rejects pending attachment view with capability remediation', () => {
  const view = pendingAttachmentViewProbe();
  assert.equal(view.status, 503);
  assert.deepEqual(view.body, {
    error: 'Set CLEARFOLIO_URL and CLEARFOLIO_HMAC_SECRET, or use SCOPEWEAVE_DEV=1 only for local development.',
    capability: 'clearfolio',
    ready: false,
    mode: 'unavailable',
    reason: 'clearfolio_not_configured',
    action: 'Set CLEARFOLIO_URL and CLEARFOLIO_HMAC_SECRET, or use SCOPEWEAVE_DEV=1 only for local development.',
  });
});
