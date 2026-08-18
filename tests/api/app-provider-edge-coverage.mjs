// Provider-mode API coverage. This process intentionally imports the app with
// hosted OIDC, contextual-orchestrator, Clearfolio, and on-disk logging enabled
// so production-only fail-closed branches remain executable under coverage.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(tmpdir(), `scopeweave-provider-edge-${process.pid}.sqlite`);
await rm(dbPath, { force: true });
process.env.SCOPEWEAVE_DB = dbPath;
process.env.SCOPEWEAVE_DEV = '0';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.OIDC_ISSUER = 'https://idp.example.test/';
process.env.OIDC_CLIENT_ID = 'scopeweave-client';
process.env.OIDC_CLIENT_SECRET = 'scopeweave-secret';
process.env.OIDC_REDIRECT_URI = 'https://scopeweave.example.test/api/auth/oidc/callback';
process.env.ORCHESTRATOR_URL = 'https://orchestrator.example.test';
process.env.ORCHESTRATOR_TOKEN = 'provider-test-token';
process.env.CLEARFOLIO_URL = 'https://clearfolio.example.test';

const [{ app }, { db }] = await Promise.all([
  import('../../server/app.mjs'),
  import('../../server/db.mjs'),
]);

const nativeFetch = globalThis.fetch;
const nativeLog = console.log;
const body = (value) => JSON.stringify(value);
const req = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return app.request(path, { ...options, headers });
};

function oidcPayload(claims) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

async function oidcState() {
  const start = await req('/api/auth/oidc/start');
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location'));
  assert.equal(location.origin, 'https://idp.example.test');
  assert.equal(location.pathname, '/authorize');
  assert.equal(location.searchParams.get('client_id'), 'scopeweave-client');
  assert.equal(location.searchParams.get('redirect_uri'), process.env.OIDC_REDIRECT_URI);
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  return location.searchParams.get('state');
}

try {
  // On-disk mode must execute structured request logging, while a logging sink
  // failure remains isolated from request handling.
  const logLines = [];
  console.log = (line) => logLines.push(line);
  let response = await req('/api/health');
  assert.equal(response.status, 200);
  assert.ok(logLines.some((line) => JSON.parse(line).path === '/api/health'));
  console.log = () => { throw new Error('simulated logging sink failure'); };
  assert.equal((await req('/api/health')).status, 200);
  console.log = () => {};

  // Hosted mode must disable the built-in mock IdP route.
  assert.equal((await req('/api/auth/oidc/mock/authorize?state=x&email=x@example.com&redirect_uri=https://scopeweave.example.test/cb')).status, 404);

  // Each callback consumes a one-time state. Exercise transport failure,
  // malformed JSON, a valid token without email, and a complete hosted login.
  globalThis.fetch = async () => { throw new Error('simulated IdP outage'); };
  let state = await oidcState();
  assert.equal((await req(`/api/auth/oidc/callback?state=${state}&code=outage`)).status, 400);

  globalThis.fetch = async () => new Response('not-json', { status: 200 });
  state = await oidcState();
  assert.equal((await req(`/api/auth/oidc/callback?state=${state}&code=bad-json`)).status, 400);

  globalThis.fetch = async () => new Response(JSON.stringify({ id_token: oidcPayload({ sub: 'no-email' }) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  state = await oidcState();
  assert.equal((await req(`/api/auth/oidc/callback?state=${state}&code=no-email`)).status, 400);

  globalThis.fetch = async () => new Response(JSON.stringify({ id_token: oidcPayload({ email: 'hosted-sso@example.com' }) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  state = await oidcState();
  response = await req(`/api/auth/oidc/callback?state=${state}&code=success`);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') || '', /^\/#token=/);

  // Create a normal tenant/project for downstream hosted-provider error paths.
  response = await req('/api/auth/signup', {
    method: 'POST',
    body: body({ email: 'provider-owner@example.com', password: 'password123', name: 'Provider Owner' }),
  });
  assert.equal(response.status, 200);
  const token = (await response.json()).token;
  const auth = { authorization: `Bearer ${token}` };
  response = await req('/api/me', { headers: auth });
  const me = await response.json();
  const userId = me.user.id;
  response = await req('/api/projects', { method: 'POST', headers: auth, body: body({ name: 'Provider Project' }) });
  assert.equal(response.status, 200);
  const projectId = (await response.json()).id;

  // contextual-orchestrator transport failures must be translated into the
  // stable browser-safe API failure rather than leaking provider details.
  globalThis.fetch = async () => { throw new Error('private orchestrator transport detail'); };
  response = await req(`/api/projects/${projectId}/ai/brief`, { method: 'POST', headers: auth, body: body({}) });
  assert.equal(response.status, 502);
  assert.doesNotMatch((await response.json()).error, /private orchestrator transport detail/);

  // Clearfolio conversion submission has the same provider-error containment.
  const upload = new FormData();
  upload.append('taskId', 'provider-task');
  upload.append('file', new Blob(['provider-pdf'], { type: 'application/pdf' }), 'provider.pdf');
  globalThis.fetch = async () => { throw new Error('private clearfolio submit detail'); };
  response = await app.request(`/api/projects/${projectId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: upload,
  });
  assert.equal(response.status, 502);
  assert.doesNotMatch((await response.json()).error, /private clearfolio submit detail/);

  // A completed persisted job whose artifact-link provider becomes unavailable
  // must also fail closed through the public API boundary.
  const attachmentId = Number(db.prepare(
    'INSERT INTO attachments(project_id,task_id,name,mime,size,job_id,status,created_by) VALUES(?,?,?,?,?,?,?,?) RETURNING id',
  ).get(projectId, 'provider-task', 'persisted.pdf', 'application/pdf', 12, 'hosted-job-1', 'SUCCEEDED', userId).id);
  globalThis.fetch = async () => { throw new Error('private artifact-link detail'); };
  response = await req(`/api/projects/${projectId}/attachments/${attachmentId}/view`, { headers: auth });
  assert.equal(response.status, 502);
  assert.doesNotMatch((await response.json()).error, /private artifact-link detail/);
} finally {
  globalThis.fetch = nativeFetch;
  console.log = nativeLog;
  await rm(dbPath, { force: true });
}

console.log('app hosted provider edge coverage: ok');
