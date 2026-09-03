// Webhook security integration: exercise the shipped API and delivery path without network I/O.
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.ORCHESTRATOR_URL;

const originalFetch = globalThis.fetch;
let legacyFetchCalls = 0;
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('https://127.0.0.1/')) {
    legacyFetchCalls += 1;
    return { status: 204, ok: true };
  }
  return originalFetch(input, init);
};

const { app } = await import('../../server/app.mjs');
const { db, rowid } = await import('../../server/db.mjs');

const body = (value) => JSON.stringify(value);
const req = (path, opts = {}) => app.request(path, {
  ...opts,
  headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
});

let response = await req('/api/auth/signup', {
  method: 'POST',
  body: body({ email: 'webhook-security@example.com', password: 'password123' }),
});
assert.equal(response.status, 200);
const token = (await response.json()).token;
const auth = { authorization: `Bearer ${token}` };

response = await req('/api/me', { headers: auth });
const orgId = (await response.json()).orgs[0].id;

response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST',
  headers: auth,
  body: body({ url: 'http://example.net/hook', events: ['project.update'] }),
});
assert.equal(response.status, 400, 'webhook registration must require HTTPS');

response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST',
  headers: auth,
  body: body({ url: 'https://127.0.0.1/hook', events: ['project.update'] }),
});
assert.equal(response.status, 400, 'webhook registration must reject non-public IP literals');

response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST',
  headers: auth,
  body: body({ url: 'https://192.168.example.net/hook', events: ['project.update'] }),
});
assert.equal(response.status, 200, 'numeric-looking public DNS names must remain registrable');
const publicDnsWebhook = await response.json();
await req(`/api/orgs/${orgId}/webhooks/${publicDnsWebhook.id}`, {
  method: 'DELETE',
  headers: auth,
});

response = await req('/api/projects', {
  method: 'POST',
  headers: auth,
  body: body({ name: 'Webhook security' }),
});
const project = await response.json();
assert.equal(response.status, 200);

// Simulate a pre-existing row that predates stricter registration validation.
// The delivery boundary must still reject it immediately before connection.
const legacyWebhookId = rowid(db.prepare(
  'INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)',
).run(orgId, 'https://127.0.0.1/hook', 'whsec_legacy', 'project.update'));

response = await req(`/api/projects/${project.id}`, {
  method: 'PUT',
  headers: auth,
  body: body({ tasks: [{ id: 'security', name: 'Security' }], version: project.version }),
});
assert.equal(response.status, 200);

await new Promise((resolve) => setTimeout(resolve, 30));
const delivery = db.prepare(
  'SELECT status_code AS statusCode, ok, attempt FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id LIMIT 1',
).get(legacyWebhookId);
assert.ok(delivery, 'legacy webhook delivery attempt must be recorded');
assert.equal(delivery.ok, 0, 'non-public persisted destinations must fail closed at delivery time');
assert.equal(delivery.statusCode, null);
assert.equal(legacyFetchCalls, 0, 'delivery must not reach the legacy global fetch path');

globalThis.fetch = originalFetch;
console.log('webhook security integration: ok');
