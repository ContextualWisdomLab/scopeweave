// Realistic API edge-path coverage for the ScopeWeave SaaS boundary.
// This suite intentionally drives error, fallback, tenant, provider-retry,
// export, stream-cleanup, and static-asset failure paths through Hono requests.
import assert from 'node:assert/strict';
import { rename } from 'node:fs/promises';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '2';
process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '2';
delete process.env.ORCHESTRATOR_URL;
delete process.env.CLEARFOLIO_URL;
delete process.env.OIDC_ISSUER;

const [{ app }, { db }] = await Promise.all([
  import('../../server/app.mjs'),
  import('../../server/db.mjs'),
]);

let ipSequence = 0;
const body = (value) => JSON.stringify(value);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const req = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (!headers.has('x-forwarded-for')) {
    ipSequence += 1;
    headers.set('x-forwarded-for', `203.0.113.${(ipSequence % 240) + 1}`);
  }
  if (!(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return app.request(path, { ...options, headers });
};

// Rate limiting: first request creates a bucket, the third request exceeds it,
// then the elapsed fixed window replaces the bucket rather than permanently
// denying the caller.
const rateHeaders = { 'x-forwarded-for': '198.51.100.9' };
assert.equal((await req('/api/metrics', { headers: rateHeaders })).status, 200);
assert.equal((await req('/api/metrics', { headers: rateHeaders })).status, 200);
assert.equal((await req('/api/metrics', { headers: rateHeaders })).status, 429);
await delay(5);
assert.equal((await req('/api/metrics', { headers: rateHeaders })).status, 200);

// Owner account and its personal workspace.
let response = await req('/api/auth/signup', {
  method: 'POST',
  body: body({ email: 'edge-owner@example.com', password: 'password123', name: '' }),
});
assert.equal(response.status, 200);
const ownerToken = (await response.json()).token;
const ownerAuth = { authorization: `Bearer ${ownerToken}` };
response = await req('/api/me', { headers: ownerAuth });
const me = await response.json();
const ownerId = me.user.id;
const orgId = me.orgs[0].id;

// Organization request parsing, normalization, and explicit-org project paths.
assert.equal((await req('/api/orgs', { method: 'POST', headers: ownerAuth, body: body({ name: '   ' }) })).status, 400);
response = await req('/api/orgs', { method: 'POST', headers: ownerAuth, body: body({ name: '  Edge Workspace  ' }) });
assert.equal(response.status, 200);
const secondaryOrgId = (await response.json()).id;

response = await req('/api/projects', { method: 'POST', headers: ownerAuth, body: body({ name: 'Edge Project', orgId }) });
assert.equal(response.status, 200);
const project = await response.json();
const projectId = project.id;

// Free-plan cap is enforced on duplicate just like create. A successful second
// project fills the cap; direct plan promotion afterward keeps subsequent edge
// cases focused on their own behavior.
assert.equal((await req('/api/projects', { method: 'POST', headers: ownerAuth, body: body({ name: 'Cap filler', orgId }) })).status, 200);
assert.equal((await req(`/api/projects/${projectId}/duplicate`, { method: 'POST', headers: ownerAuth, body: body({}) })).status, 402);
db.prepare("UPDATE orgs SET plan = 'pro' WHERE id = ?").run(orgId);
response = await req(`/api/projects/${projectId}/duplicate`, { method: 'POST', headers: ownerAuth, body: body({ name: '' }) });
assert.equal(response.status, 200);
assert.match((await response.json()).name, /복사본/);

// Missing tasks/name/base-date fields exercise the persisted-value fallbacks;
// valid methodology and task content exercise calendar/portfolio/briefing paths.
let loaded = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
const datedTasks = [
  {
    id: 'late,1',
    name: 'Late, task;\\name\nnext',
    plannedStartDate: '2020-01-01',
    plannedEndDate: '2020-01-02',
    plannedProgress: 100,
    actualProgress: 20,
    owner: 'Owner A',
    weight: 2,
  },
  {
    id: 'future',
    task: 'Future task',
    plannedStartDate: '2999-01-01',
    plannedEndDate: '2999-01-02',
    plannedProgress: 0,
    actualProgress: 0,
  },
  { id: 'invalid-date', name: 'Invalid', plannedStartDate: 'not-a-date', plannedEndDate: '2999-01-02' },
  { id: 'fallback-name', plannedStartDate: '2999-02-01', plannedEndDate: '2999-02-01' },
];
response = await req(`/api/projects/${projectId}`, {
  method: 'PUT',
  headers: ownerAuth,
  body: body({ tasks: datedTasks, version: loaded.version, methodology: 'agile' }),
});
assert.equal(response.status, 200);

// Comment list without taskId takes the all-comments query. Empty/oversized
// bodies and cross-tenant project access keep request validation explicit.
assert.equal((await req(`/api/projects/${projectId}/comments`, { method: 'POST', headers: ownerAuth, body: body({ body: '   ' }) })).status, 400);
assert.equal((await req(`/api/projects/${projectId}/comments`, { method: 'POST', headers: ownerAuth, body: body({ body: 'x'.repeat(2001) }) })).status, 400);
response = await req(`/api/projects/${projectId}/comments`, { method: 'POST', headers: ownerAuth, body: body({ taskId: '', body: 'Edge comment' }) });
assert.equal(response.status, 200);
const commentId = (await response.json()).id;
response = await req(`/api/projects/${projectId}/comments`, { headers: ownerAuth });
assert.equal(response.status, 200);
assert.ok((await response.json()).comments.some((item) => item.id === commentId));

// A second user cannot select an inaccessible explicit organization.
response = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'edge-other@example.com', password: 'password123' }) });
const otherToken = (await response.json()).token;
const otherAuth = { authorization: `Bearer ${otherToken}` };
assert.equal((await req('/api/projects', { method: 'POST', headers: otherAuth, body: body({ name: 'Nope', orgId }) })).status, 400);
assert.equal((await req(`/api/projects/${projectId}/comments/${commentId}`, { method: 'DELETE', headers: otherAuth })).status, 404);

// PAT authentication on calendar + attachment-view paths. The calendar includes
// escaped text, skips malformed dates, and uses task/id fallback names.
response = await req('/api/tokens', { method: 'POST', headers: ownerAuth, body: body({ name: '' }) });
assert.equal(response.status, 200);
const pat = await response.json();
const patAuth = { authorization: `Bearer ${pat.token}` };
response = await req(`/api/projects/${projectId}/calendar.ics`, { headers: patAuth });
assert.equal(response.status, 200);
const calendar = await response.text();
assert.match(calendar, /BEGIN:VCALENDAR/);
assert.match(calendar, /Late\\, task\\;\\\\name\\nnext/);
assert.doesNotMatch(calendar, /invalid-date/);

const upload = new FormData();
upload.append('taskId', 'edge-task');
upload.append('file', new Blob(['edge-pdf'], { type: 'application/pdf' }), 'edge.pdf');
response = await app.request(`/api/projects/${projectId}/attachments`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ownerToken}`, 'x-forwarded-for': '203.0.113.250' },
  body: upload,
});
assert.equal(response.status, 200);
const attachmentId = (await response.json()).id;
response = await req(`/api/projects/${projectId}/attachments/${attachmentId}/view`, { headers: patAuth });
assert.equal(response.status, 302);
assert.match(response.headers.get('location') || '', /mock-clearfolio/);

// Stripe completion accepts both documented organization-id locations.
for (const event of [
  { type: 'checkout.session.completed', data: { object: { client_reference_id: String(orgId) } } },
  { type: 'checkout.session.completed', data: { object: { metadata: { orgId: String(secondaryOrgId) } } } },
  { type: 'ignored.event', data: { object: {} } },
]) {
  assert.equal((await req('/api/stripe/webhook', { method: 'POST', body: body(event) })).status, 200);
}

// Mock OIDC: reject a consumed state with a forged code, then complete a real
// self-contained flow for an already-existing user (upsert fast path).
async function mockCallbackPath(email) {
  const start = await req(`/api/auth/oidc/start?email=${encodeURIComponent(email)}`);
  assert.equal(start.status, 302);
  const authorizeUrl = new URL(start.headers.get('location'));
  const authorize = await req(`${authorizeUrl.pathname}${authorizeUrl.search}`);
  assert.equal(authorize.status, 302);
  const callbackUrl = new URL(authorize.headers.get('location'));
  return callbackUrl;
}
let callbackUrl = await mockCallbackPath('edge-owner@example.com');
const badCallback = new URL(callbackUrl);
badCallback.searchParams.set('code', 'forged-code');
assert.equal((await req(`${badCallback.pathname}${badCallback.search}`)).status, 400);
callbackUrl = await mockCallbackPath('edge-owner@example.com');
response = await req(`${callbackUrl.pathname}${callbackUrl.search}`);
assert.equal(response.status, 302);
assert.match(response.headers.get('location') || '', /^\/#token=/);
assert.equal((await req('/api/auth/oidc/callback?state=missing&code=missing')).status, 400);

// Search and portfolio gracefully contain corrupted stored task JSON rather
// than leaking or crashing. Restore realistic tasks afterward for AI briefing.
db.prepare('UPDATE projects SET tasks_json = ? WHERE id = ?').run('{not-json', projectId);
assert.equal((await req('/api/search?q=x', { headers: ownerAuth })).status, 400);
response = await req('/api/search?q=Edge', { headers: ownerAuth });
assert.equal(response.status, 200);
assert.ok((await response.json()).results.some((item) => item.projectId === projectId));
response = await req(`/api/orgs/${orgId}/portfolio`, { headers: ownerAuth });
assert.equal(response.status, 200);
assert.ok((await response.json()).projects.some((item) => item.id === projectId && item.tasks === 0));
db.prepare('UPDATE projects SET tasks_json = ? WHERE id = ?').run(JSON.stringify(datedTasks), projectId);
response = await req(`/api/projects/${projectId}/ai/brief`, { method: 'POST', headers: ownerAuth, body: body({}) });
assert.equal(response.status, 200);
assert.ok((await response.json()).analysis);
assert.equal((await req('/api/projects/999999/ai/brief', { method: 'POST', headers: ownerAuth, body: body({}) })).status, 404);

// Webhook retries are observable: HTTP failure -> transport failure -> success.
response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST',
  headers: ownerAuth,
  body: body({ url: 'https://hooks.example.test/scopeweave', events: ['project.update'] }),
});
assert.equal(response.status, 200);
const webhookId = (await response.json()).id;
const nativeFetch = globalThis.fetch;
let webhookAttempts = 0;
globalThis.fetch = async () => {
  webhookAttempts += 1;
  if (webhookAttempts === 1) return new Response('retry', { status: 503 });
  if (webhookAttempts === 2) throw new Error('simulated transport reset');
  return new Response(null, { status: 204 });
};
try {
  loaded = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
  response = await req(`/api/projects/${projectId}`, {
    method: 'PUT',
    headers: ownerAuth,
    body: body({ version: loaded.version }),
  });
  assert.equal(response.status, 200);
  await delay(1150);
} finally {
  globalThis.fetch = nativeFetch;
}
assert.equal(webhookAttempts, 3);
response = await req(`/api/orgs/${orgId}/webhooks/${webhookId}/deliveries`, { headers: ownerAuth });
assert.equal(response.status, 200);
assert.equal((await response.json()).deliveries.length, 3);
assert.equal((await req(`/api/orgs/${orgId}/webhooks/999999/deliveries`, { headers: ownerAuth })).status, 404);
assert.equal((await req(`/api/orgs/${orgId}/webhooks/999999/rotate`, { method: 'POST', headers: ownerAuth })).status, 404);
assert.equal((await req(`/api/orgs/${orgId}/webhooks/999999`, { method: 'DELETE', headers: ownerAuth })).status, 404);
assert.equal((await req(`/api/orgs/${orgId}/webhooks/${webhookId}`, { method: 'DELETE', headers: ownerAuth })).status, 200);

// Stream cleanup executes the abort listener on the request signal.
const abortController = new AbortController();
response = await app.request(new Request(`http://localhost/api/projects/${projectId}/stream`, {
  headers: { authorization: `Bearer ${ownerToken}`, 'x-forwarded-for': '203.0.113.249' },
  signal: abortController.signal,
}));
assert.equal(response.status, 200);
abortController.abort();
await delay(0);
await response.body?.cancel().catch(() => undefined);
assert.equal((await req('/api/metrics?format=prometheus')).status, 200);

// Audit CSV protects spreadsheet consumers against formula execution and takes
// the capped explicit-limit branch while JSON remains available.
db.prepare('INSERT INTO audit_log(org_id,user_id,action,target_type,target_id,meta) VALUES(?,?,?,?,?,?)')
  .run(orgId, ownerId, '=dangerous_formula()', 'edge,type', 'edge"id', JSON.stringify({ note: 'quoted,value' }));
const originalEmail = me.user.email;
db.prepare('UPDATE users SET email = ? WHERE id = ?').run(' =2+3', ownerId);
response = await req(`/api/orgs/${orgId}/audit?format=csv&limit=1000`, { headers: ownerAuth });
assert.equal(response.status, 200);
const csv = await response.text();
assert.match(csv, /'=dangerous_formula\(\)/);
assert.match(csv, /' =2\+3/);
db.prepare('UPDATE users SET email = ? WHERE id = ?').run(originalEmail, ownerId);
assert.equal((await req(`/api/orgs/${orgId}/audit?limit=0`, { headers: ownerAuth })).status, 200);

// Token deletion not-found and owner-only workspace operations retain explicit
// fail-closed behavior.
assert.equal((await req('/api/tokens/999999', { method: 'DELETE', headers: ownerAuth })).status, 404);
assert.equal((await req(`/api/orgs/${orgId}/transfer`, { method: 'POST', headers: ownerAuth, body: body({ userId: ownerId }) })).status, 400);
assert.equal((await req(`/api/orgs/${orgId}`, { method: 'PATCH', headers: ownerAuth, body: body({ name: '' }) })).status, 400);
assert.equal((await req(`/api/orgs/${orgId}/leave`, { method: 'POST', headers: ownerAuth })).status, 403);

// A mapped static asset that disappears at deployment time must fail closed as
// a 404. Restore the asset in finally so later jobs never inherit test damage.
const staticPath = 'robots.txt';
const hiddenPath = 'robots.txt.coverage-edge';
await rename(staticPath, hiddenPath);
try {
  assert.equal((await req('/robots.txt')).status, 404);
} finally {
  await rename(hiddenPath, staticPath);
}

console.log('app edge coverage: ok');
