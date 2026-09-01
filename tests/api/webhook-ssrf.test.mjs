// Security regression: webhook destinations must be safe at registration and delivery time.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');
const { db, rowid } = await import('../../server/db.mjs');

const body = (value) => JSON.stringify(value);
const req = (path, options = {}) => app.request(path, {
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});

let response = await req('/api/auth/signup', {
  method: 'POST',
  body: body({ email: 'webhook-security@example.test', password: 'password123' }),
});
assert.equal(response.status, 200);
const signup = await response.json();
const auth = { authorization: `Bearer ${signup.token}` };
const orgId = signup.org.id;

// RED: plaintext webhook transport exposes signed event payloads and must be rejected.
response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST',
  headers: auth,
  body: body({ url: 'http://198.51.100.10/hook', events: ['never'] }),
});
assert.equal(response.status, 400, 'webhook registration requires HTTPS');

// RED: IPv6 unique-local and localhost variants are not globally routable destinations.
for (const unsafeUrl of ['https://[fc00::1]/hook', 'https://localhost./hook']) {
  response = await req(`/api/orgs/${orgId}/webhooks`, {
    method: 'POST',
    headers: auth,
    body: body({ url: unsafeUrl, events: ['never'] }),
  });
  assert.equal(response.status, 400, `${unsafeUrl} is rejected`);
}

// RED: DNS labels that merely start with private-looking octets are ordinary hostnames.
response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST',
  headers: auth,
  body: body({ url: 'https://192.168.example.com/hook', events: ['never'] }),
});
assert.equal(response.status, 200, 'numeric-looking public hostname is not mistaken for an IP literal');
const safeWebhook = await response.json();

// RED: legacy persisted rows must be revalidated at the network boundary, not trusted because
// they predate the registration validator. A loopback listener must receive zero requests.
let loopbackHits = 0;
const loopbackServer = createServer((request, serverResponse) => {
  loopbackHits += 1;
  request.resume();
  serverResponse.writeHead(204);
  serverResponse.end();
});
await new Promise((resolve, reject) => {
  loopbackServer.once('error', reject);
  loopbackServer.listen(0, '127.0.0.1', resolve);
});
const address = loopbackServer.address();
assert.ok(address && typeof address === 'object');
const legacyWebhookId = rowid(db.prepare(
  'INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)'
).run(orgId, `http://127.0.0.1:${address.port}/hook`, 'whsec_legacy_test', 'project.update'));

response = await req('/api/projects', {
  method: 'POST',
  headers: auth,
  body: body({ name: 'Webhook SSRF boundary' }),
});
assert.equal(response.status, 200);
const project = await response.json();
response = await req(`/api/projects/${project.id}`, {
  method: 'PUT',
  headers: auth,
  body: body({ tasks: [{ id: 'security-task', name: 'Verify destination' }], version: project.version }),
});
assert.equal(response.status, 200);
await new Promise((resolve) => setTimeout(resolve, 700));
assert.equal(loopbackHits, 0, 'delivery-time validation prevents loopback network access');

response = await req(`/api/orgs/${orgId}/webhooks/${legacyWebhookId}/deliveries`, { headers: auth });
assert.equal(response.status, 200);
const deliveries = (await response.json()).deliveries;
assert.ok(deliveries.length >= 2, 'blocked delivery is recorded and retried');
assert.ok(deliveries.every((delivery) => delivery.ok === 0), 'blocked delivery is fail-closed');
assert.ok(deliveries.some((delivery) => delivery.attempt === 2), 'blocked delivery follows bounded retry policy');

await new Promise((resolve, reject) => loopbackServer.close((error) => error ? reject(error) : resolve()));
response = await req(`/api/orgs/${orgId}/webhooks/${safeWebhook.id}`, { method: 'DELETE', headers: auth });
assert.equal(response.status, 200);

console.log('webhook SSRF boundary security tests passed');
