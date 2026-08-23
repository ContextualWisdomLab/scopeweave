import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SCOPEWEAVE_DB = ':memory:';
delete process.env.SCOPEWEAVE_DEV;
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const facadeSource = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(
  facadeSource,
  /valid http\(s\) url required/,
  'registration facade does not retain the superseded core error contract',
);

const { app } = await import('../../server/app.mjs');
const { app: coreApp } = await import('../../server/app_core.mjs');

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

response = await coreApp.request(`/api/orgs/${organizationId}/webhooks`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...authorization,
  },
  body: json({ url: 'https://127.0.0.1/private', events: ['project.updated'] }),
});
assert.equal(response.status, 400, 'core webhook registration cannot bypass the destination policy');
assert.deepEqual(
  await response.json(),
  { error: 'valid public https webhook URL required' },
  'core registration rejects private destinations without resolver details',
);

let unauthenticatedBodyPulls = 0;
const unauthenticatedBody = new ReadableStream({
  pull(controller) {
    unauthenticatedBodyPulls += 1;
    controller.enqueue(new TextEncoder().encode('x'.repeat(8192)));
    if (unauthenticatedBodyPulls >= 8) controller.close();
  },
});
response = await request(`/api/orgs/${organizationId}/webhooks`, {
  method: 'POST',
  body: unauthenticatedBody,
  duplex: 'half',
});
assert.equal(response.status, 401, 'webhook registration authenticates before reading an untrusted request body');
assert.ok(
  unauthenticatedBodyPulls <= 1,
  `unauthenticated webhook body must not be drained before auth; observed ${unauthenticatedBodyPulls} stream pulls`,
);

let authorizedBodyPulls = 0;
const oversizedAuthorizedBody = new ReadableStream({
  pull(controller) {
    authorizedBodyPulls += 1;
    controller.enqueue(new TextEncoder().encode('x'.repeat(8192)));
    if (authorizedBodyPulls >= 8) controller.close();
  },
});
response = await request(`/api/orgs/${organizationId}/webhooks`, {
  method: 'POST',
  headers: authorization,
  body: oversizedAuthorizedBody,
  duplex: 'half',
});
assert.equal(response.status, 413, 'authorized webhook registration bodies have a bounded memory budget');
assert.deepEqual(
  await response.json(),
  { error: 'webhook registration body too large' },
  'oversized registration returns a stable buyer-actionable error',
);
assert.ok(
  authorizedBodyPulls <= 3,
  `oversized webhook body must stop near the 16 KiB budget; observed ${authorizedBodyPulls} stream pulls`,
);

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
