import assert from 'node:assert';
import { Agent, MockAgent } from 'undici';
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
  '::127.0.0.1',
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
  'https://[::127.0.0.1]/hook',
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
let projectVersion = project.version;

// Exercise the production sendWebhook path with Undici's Dispatcher contract.
// A 302 with a private Location must be recorded as a failed attempt and retried
// once, but the redirect target itself must never be dispatched.
db.prepare('UPDATE webhooks SET url = ? WHERE id = ?')
  .run('https://webhook.example.test/start', webhookId);
db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(webhookId);

const redirectAgent = new MockAgent();
redirectAgent.disableNetConnect();
redirectAgent
  .get('https://webhook.example.test')
  .intercept({ path: '/start', method: 'POST' })
  .reply(302, '', { headers: { location: 'https://169.254.169.254/internal' } })
  .times(2);
redirectAgent
  .get('https://169.254.169.254')
  .intercept({ path: '/internal', method: 'POST' })
  .reply(204, '');

const { safeWebhookAgent } = await import('../../server/app.mjs');
const originalSafeAgentDispatch = safeWebhookAgent.dispatch;

let webhookDispatches = 0;
safeWebhookAgent.dispatch = function dispatchThroughRedirectFixture(options, handler) {
  webhookDispatches += 1;
  return redirectAgent.dispatch(options, handler);
};
try {
  response = await req(`/api/projects/${project.id}`, {
    method: 'PUT',
    headers: auth,
    body: body({ version: projectVersion, name: 'Webhook redirect boundary', tasks: [] }),
  });
  assert.equal(response.status, 200, 'project update succeeds independently of rejected webhook redirects');
  projectVersion = (await response.json()).version;
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const deliveries = db.prepare(
    'SELECT status_code AS statusCode, ok, attempt FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id',
  ).all(webhookId);
  assert.equal(webhookDispatches, 2, 'a rejected redirect is attempted once and retried exactly once');
  assert.deepEqual(
    deliveries.map(({ statusCode, ok, attempt }) => ({ statusCode, ok, attempt })),
    [
      { statusCode: null, ok: 0, attempt: 1 },
      { statusCode: null, ok: 0, attempt: 2 },
    ],
    'redirect rejection preserves the delivery receipt and one-retry contract',
  );
  const pendingRedirects = redirectAgent.pendingInterceptors();
  assert.equal(pendingRedirects.length, 1, 'only the private redirect target remains unrequested');
  assert.equal(pendingRedirects[0].origin, 'https://169.254.169.254');
  assert.equal(pendingRedirects[0].path, '/internal');
} finally {
  safeWebhookAgent.dispatch = originalSafeAgentDispatch;
  await redirectAgent.close();
}

// Persisted private literals must be rejected before the production transport
// is dispatched. Count Agent dispatches rather than monkeypatching global fetch:
// webhook delivery intentionally uses the isolated Undici transport.
db.prepare('UPDATE webhooks SET url = ? WHERE id = ?')
  .run('https://127.0.0.1:9/internal', webhookId);
let blockedDispatches = 0;
safeWebhookAgent.dispatch = function failIfBlockedDestinationReachesTransport() {
  blockedDispatches += 1;
  throw new Error('blocked webhook destination reached network transport');
};
try {
  response = await req(`/api/projects/${project.id}`, {
    method: 'PUT',
    headers: auth,
    body: body({ version: projectVersion, name: 'Webhook delivery boundary', tasks: [] }),
  });
  assert.equal(response.status, 200, 'project update succeeds independently of webhook delivery');
  assert.equal(blockedDispatches, 0, 'persisted non-public IP literals are refused before network dispatch');
} finally {
  safeWebhookAgent.dispatch = originalSafeAgentDispatch;
}

console.log('✓ webhook SSRF registration, DNS admission, redirect, and delivery-boundary regression tests passed');
