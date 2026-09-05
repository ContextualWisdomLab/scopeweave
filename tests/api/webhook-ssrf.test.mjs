import assert from 'node:assert';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

const req = (path, opts = {}) =>
  app.request(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
const body = (value) => JSON.stringify(value);

let response = await req('/api/auth/signup', {
  method: 'POST',
  body: body({ email: 'ssrf-owner@example.test', password: 'password123', name: 'SSRF owner' }),
});
assert.equal(response.status, 200, 'signup succeeds');
const { token } = await response.json();
const auth = { authorization: `Bearer ${token}` };

response = await req('/api/me', { headers: auth });
assert.equal(response.status, 200, 'owner workspace is available');
const orgId = (await response.json()).orgs[0].id;

for (const url of [
  'https://[fc00::1]/hook',
  'https://[fe80::1]/hook',
  'https://[::ffff:127.0.0.1]/hook',
  'http://example.com/hook',
]) {
  response = await req(`/api/orgs/${orgId}/webhooks`, {
    method: 'POST',
    headers: auth,
    body: body({ url, events: ['project.update'] }),
  });
  assert.equal(response.status, 400, `${url} must fail closed at webhook registration`);
}

response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST',
  headers: auth,
  body: body({ url: 'https://example.com/hook', events: ['project.update'] }),
});
assert.equal(response.status, 200, 'public HTTPS webhook registration remains available');
const webhookId = (await response.json()).id;

// Delivery is a separate security boundary from registration. A legacy row,
// restore, migration, or future DNS result must not become trusted merely
// because the destination was admissible when the webhook was created.
response = await req('/api/projects', {
  method: 'POST',
  headers: auth,
  body: body({ name: 'Webhook delivery boundary', orgId }),
});
assert.equal(response.status, 200, 'project fixture is created');
const project = await response.json();

db.prepare('UPDATE webhooks SET url = ? WHERE id = ?')
  .run('https://127.0.0.1:9/internal', webhookId);

const originalFetch = globalThis.fetch;
const outboundAttempts = [];
globalThis.fetch = async (url, options) => {
  outboundAttempts.push({ url: String(url), options });
  return { status: 204, ok: true };
};
try {
  response = await req(`/api/projects/${project.id}`, {
    method: 'PUT',
    headers: auth,
    body: body({ version: project.version, name: 'Webhook delivery boundary', tasks: [] }),
  });
  assert.equal(response.status, 200, 'project update succeeds independently of webhook delivery');
  assert.equal(
    outboundAttempts.length,
    0,
    'delivery must revalidate persisted destinations and refuse non-public IP literals before network I/O',
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('✓ webhook SSRF registration and delivery-boundary regression tests passed');
