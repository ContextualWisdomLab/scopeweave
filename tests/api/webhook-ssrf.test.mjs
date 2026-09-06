import assert from 'node:assert';
import { MockAgent } from 'undici';
import {
  createSafeWebhookLookup,
  isPublicWebhookIp,
  isSafeWebhookUrl,
} from '../../server/webhook_destination.mjs';

for (const address of [
  '0.0.0.0',
  '10.0.0.1',
  '100.64.0.1',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '192.168.0.1',
  '198.18.0.1',
  '224.0.0.1',
  '240.0.0.1',
  '::',
  '::1',
  '::ffff:127.0.0.1',
  '64:ff9b:1::1',
  '2001:db8::1',
  '2002:7f00:1::',
  'fc00::1',
  'fe80::1',
  'ff00::1',
]) {
  assert.equal(isPublicWebhookIp(address), false, `${address} must not be a webhook destination`);
}
for (const address of [
  '1.1.1.1',
  '8.8.8.8',
  '2001:4860:4860::8888',
  '2606:4700:4700::1111',
]) {
  assert.equal(isPublicWebhookIp(address), true, `${address} remains a public webhook destination`);
}

for (const url of [
  'http://example.com/hook',
  'https://localhost/hook',
  'https://service.local/hook',
  'https://127.0.0.1/hook',
  'https://100.64.0.1/hook',
  'https://198.18.0.1/hook',
  'https://[::ffff:127.0.0.1]/hook',
  'https://user:secret@example.com/hook',
]) {
  assert.equal(isSafeWebhookUrl(url), false, `${url} must fail closed before persistence or delivery`);
}
assert.equal(isSafeWebhookUrl('https://example.com/hook'), true, 'public HTTPS hostname remains admissible');

function runLookup(lookup, hostname = 'webhook.example.test', options = {}) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

const privateOnlyLookup = createSafeWebhookLookup((_hostname, options, callback) => {
  assert.equal(options.all, true, 'guarded lookup inspects every resolved address');
  assert.equal(options.family, 0, 'guarded lookup requests both address families');
  callback(null, [{ address: '127.0.0.1', family: 4 }]);
});
await assert.rejects(
  runLookup(privateOnlyLookup),
  /SSRF blocked/,
  'a private-only DNS answer must fail before socket connection',
);

const mixedLookup = createSafeWebhookLookup((_hostname, _options, callback) => {
  callback(null, [
    { address: '93.184.216.34', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ]);
});
await assert.rejects(
  runLookup(mixedLookup),
  /SSRF blocked/,
  'one non-public A or AAAA answer must reject the hostname instead of racing the public answer',
);

const publicLookup = createSafeWebhookLookup((_hostname, _options, callback) => {
  callback(null, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]);
});
assert.deepEqual(
  await runLookup(publicLookup),
  { address: '93.184.216.34', family: 4 },
  'socket lookup must return the exact admitted address rather than resolving the hostname again',
);

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
const { app, requestWebhook } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

const redirectAgent = new MockAgent();
redirectAgent.disableNetConnect();
redirectAgent
  .get('https://webhook.example.test')
  .intercept({ path: '/start', method: 'POST' })
  .reply(302, '', { headers: { location: 'https://169.254.169.254/internal' } });
redirectAgent
  .get('https://169.254.169.254')
  .intercept({ path: '/internal', method: 'POST' })
  .reply(204, '');
try {
  await assert.rejects(
    requestWebhook(
      'https://webhook.example.test/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
      redirectAgent,
    ),
    /fetch failed|redirect/i,
    'webhook transport must reject a redirect response instead of following its Location target',
  );
  const pendingRedirects = redirectAgent.pendingInterceptors();
  assert.equal(pendingRedirects.length, 1, 'only the redirect target should remain unrequested');
  assert.equal(pendingRedirects[0].origin, 'https://169.254.169.254');
  assert.equal(pendingRedirects[0].path, '/internal');
} finally {
  await redirectAgent.close();
}

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
  'https://100.64.0.1/hook',
  'https://198.18.0.1/hook',
  'http://169.254.169.254/hook',
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

console.log('✓ webhook SSRF registration, DNS admission, redirect, and delivery-boundary regression tests passed');
