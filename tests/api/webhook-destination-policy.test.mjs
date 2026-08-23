import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
delete process.env.SCOPEWEAVE_DEV;
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

const request = (path, options = {}) => app.request(path, {
  ...options,
  headers: {
    'content-type': 'application/json',
    ...(options.headers || {}),
  },
});
const json = (value) => JSON.stringify(value);

let response = await request('/api/auth/signup', {
  method: 'POST',
  body: json({ email: 'webhook-owner@example.test', password: 'password123', name: 'Webhook Owner' }),
});
assert.equal(response.status, 200, 'fixture owner signup succeeds');
const signup = await response.json();
const authorization = { authorization: `Bearer ${signup.token}` };

response = await request('/api/me', { headers: authorization });
assert.equal(response.status, 200, 'fixture owner can resolve organization');
const me = await response.json();
const organizationId = me.orgs[0].id;

for (const headers of [{}, { authorization: 'Bearer invalid-token' }]) {
  response = await request(`/api/orgs/${organizationId}/webhooks`, {
    method: 'POST',
    headers,
    body: json({ url: 'http://127.0.0.1/private', events: ['project.updated'] }),
  });
  assert.equal(response.status, 401, 'destination policy never preempts authentication');
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
}

const deniedDestinations = [
  'http://example.com/hook',
  'https://localhost/hook',
  'https://api.localhost/hook',
  'https://127.0.0.1/hook',
  'https://2130706433/hook',
  'https://0x7f000001/hook',
  'https://169.254.169.254/latest/meta-data',
  'https://10.0.0.8/hook',
  'https://192.168.50.12/hook',
  'https://[::1]/hook',
  'https://[fc00::1]/hook',
  'https://[::ffff:127.0.0.1]/hook',
  'https://user:password@example.com/hook',
  'https://example.com/hook#fragment',
];

for (const url of deniedDestinations) {
  response = await request(`/api/orgs/${organizationId}/webhooks`, {
    method: 'POST',
    headers: authorization,
    body: json({ url, events: ['project.updated'] }),
  });
  assert.equal(response.status, 400, `production webhook registration rejects unsafe destination ${url}`);
  assert.deepEqual(
    await response.json(),
    { error: 'valid public https webhook URL required' },
    'registration failure stays stable and does not disclose resolver or address details',
  );
}

response = await request(`/api/orgs/${organizationId}/webhooks`, {
  method: 'POST',
  headers: authorization,
  body: json({ url: 'https://hooks.example.com/scopeweave?tenant=buyer', events: ['project.updated'] }),
});
assert.equal(response.status, 200, 'canonical public HTTPS webhook registration remains supported');
const created = await response.json();
assert.equal(created.url, 'https://hooks.example.com/scopeweave?tenant=buyer');
assert.equal(created.events, 'project.updated');
assert.match(created.secret, /^whsec_[A-Za-z0-9_-]+$/, 'secret is returned only at creation');

response = await request(`/api/orgs/${organizationId}/webhooks`, {
  method: 'POST',
  headers: authorization,
  body: json({
    url: 'HTTPS://HOOKS.EXAMPLE.COM:443/staging/../scopeweave?tenant=buyer',
    events: ['project.updated'],
  }),
});
assert.equal(response.status, 200, 'equivalent public HTTPS spelling remains accepted');
const canonicalized = await response.json();
assert.equal(
  canonicalized.url,
  'https://hooks.example.com/scopeweave?tenant=buyer',
  'registration persists and returns the canonical authority/path rather than attacker-controlled spelling',
);

response = await request(`/api/orgs/${organizationId}/webhooks`, {
  headers: authorization,
});
assert.equal(response.status, 200, 'owner can inspect registered webhook destinations');
const listing = await response.json();
assert.equal(
  listing.webhooks.find((webhook) => webhook.id === canonicalized.id)?.url,
  'https://hooks.example.com/scopeweave?tenant=buyer',
  'canonical destination is durable in storage and therefore reused by later delivery attempts',
);

console.log('webhook destination registration policy tests passed');
