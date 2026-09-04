import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  isPublicWebhookAddress,
  parseWebhookUrl,
  postWebhookOnce,
  resolvePublicWebhookTarget,
} from '../../server/webhook_transport.mjs';

const privateCases = [
  '127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1',
  '0.0.0.0', '224.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', '::ffff:7f00:1',
];
for (const address of privateCases) {
  test(`rejects non-public address ${address}`, () => assert.equal(isPublicWebhookAddress(address), false));
}

test('allows public IPv4 and IPv6 addresses', () => {
  assert.equal(isPublicWebhookAddress('8.8.8.8'), true);
  assert.equal(isPublicWebhookAddress('2001:4860:4860::8888'), true);
  assert.equal(isPublicWebhookAddress('::ffff:808:808'), true);
});

test('evaluates RFC 6052 well-known-prefix translations by embedded IPv4 policy', () => {
  assert.equal(isPublicWebhookAddress('64:ff9b::808:808'), true);
  assert.equal(isPublicWebhookAddress('64:ff9b::a00:1'), false);
  assert.equal(isPublicWebhookAddress('64:ff9b::7f00:1'), false);
});

test('evaluates RFC 8215 local-use /48 translations by embedded IPv4 policy', () => {
  assert.equal(isPublicWebhookAddress('64:ff9b:1:808:8:800::'), true);
  assert.equal(isPublicWebhookAddress('64:ff9b:1:a00:0:100:0:0'), false);
  assert.equal(isPublicWebhookAddress('64:ff9b:1:7f00:0:100:0:0'), false);
});

test('rejects malformed local-use translation addresses with a non-zero u octet', () => {
  assert.equal(isPublicWebhookAddress('64:ff9b:1:808:108:800::'), false);
});

test('normalizes shorthand/integer IPv4 before policy evaluation', async () => {
  await assert.rejects(resolvePublicWebhookTarget('https://127.1/hook'), /non-public/);
  await assert.rejects(resolvePublicWebhookTarget('https://2130706433/hook'), /non-public/);
});

test('requires HTTPS and forbids embedded credentials', () => {
  assert.throws(() => parseWebhookUrl('http://example.net/hook'), /https/);
  assert.throws(() => parseWebhookUrl('https://user:pass@example.net/hook'), /credentials/);
});

test('does not confuse numeric-looking DNS labels with IPv4 literals', async () => {
  const target = await resolvePublicWebhookTarget('https://192.168.example.net/hook', {
    lookup: async (hostname) => {
      assert.equal(hostname, '192.168.example.net');
      return [{ address: '8.8.8.8', family: 4 }];
    },
  });
  assert.deepEqual(target.addresses, [{ address: '8.8.8.8', family: 4 }]);
});

test('rejects DNS answers if any resolved address is non-public', async () => {
  await assert.rejects(resolvePublicWebhookTarget('https://hooks.example.net/hook', {
    lookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ],
  }), /non-public/);
});

test('pins the validated address while retaining TLS hostname identity and never follows redirects', async () => {
  let requestOptions;
  let pinnedAddress;
  const fakeRequest = (options, onResponse) => {
    requestOptions = options;
    const req = new EventEmitter();
    req.end = () => {
      options.lookup(options.hostname, {}, (_error, address) => { pinnedAddress = address; });
      const response = new EventEmitter();
      response.statusCode = 302;
      response.destroy = () => {};
      queueMicrotask(() => onResponse(response));
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };

  const result = await postWebhookOnce({
    url: 'https://hooks.example.net/redirect',
    headers: { 'x-scopeweave-signature': 'sha256=test' },
    body: '{}',
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: fakeRequest,
  });

  assert.equal(pinnedAddress, '8.8.8.8');
  assert.equal(requestOptions.hostname, 'hooks.example.net');
  assert.equal(requestOptions.servername, 'hooks.example.net');
  assert.deepEqual(result, { status: 302, ok: false });
});

test('rejects malformed URLs and empty DNS answers', async () => {
  assert.throws(() => parseWebhookUrl('not a url'), /invalid/);
  await assert.rejects(resolvePublicWebhookTarget('https://hooks.example.net/hook', {
    lookup: async () => [],
  }), /did not resolve/);
});

test('deduplicates validated DNS answers', async () => {
  const target = await resolvePublicWebhookTarget('https://hooks.example.net/hook', {
    lookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ],
  });
  assert.deepEqual(target.addresses, [
    { address: '8.8.8.8', family: 4 },
    { address: '2001:4860:4860::8888', family: 6 },
  ]);
});

test('rejects malformed DNS results', async () => {
  await assert.rejects(resolvePublicWebhookTarget('https://hooks.example.net/hook', {
    lookup: async () => [{ address: 'not-an-ip', family: 0 }],
  }), /non-public/);
});

test('bounds DNS resolution time', async () => {
  await assert.rejects(resolvePublicWebhookTarget('https://hooks.example.net/hook', {
    lookup: async () => new Promise(() => {}),
    dnsTimeoutMs: 5,
  }), /DNS resolution timed out/);
});

test('clears connect timer after TLS connects and reports 2xx success', async () => {
  let destroyed = false;
  const fakeRequest = (options, onResponse) => {
    const req = new EventEmitter();
    const socket = new EventEmitter();
    req.end = () => {
      queueMicrotask(() => {
        req.emit('socket', socket);
        socket.emit('secureConnect');
        const response = new EventEmitter();
        response.statusCode = 204;
        response.destroy = () => { destroyed = true; };
        onResponse(response);
      });
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };

  const result = await postWebhookOnce({
    url: 'https://hooks.example.net/hook',
    headers: {},
    body: '{}',
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: fakeRequest,
  });

  assert.deepEqual(result, { status: 204, ok: true });
  assert.equal(destroyed, true);
});

test('propagates request failures without retrying or redirecting inside the transport', async () => {
  const failure = new Error('connect failed');
  const fakeRequest = () => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => req.emit('error', failure));
    req.destroy = (error) => req.emit('error', error);
    return req;
  };

  await assert.rejects(postWebhookOnce({
    url: 'https://hooks.example.net/hook',
    headers: {},
    body: '{}',
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: fakeRequest,
  }), failure);
});

test('application delivery records and retries a persisted blocked destination without network access', async () => {
  process.env.SCOPEWEAVE_DB = ':memory:';
  process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
  const [{ app }, { db, rowid }] = await Promise.all([
    import('../../server/app.mjs'),
    import('../../server/db.mjs'),
  ]);
  const req = (path, opts = {}) => app.request(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });

  let response = await req('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email: 'webhook-contract@example.net', password: 'password123', name: 'Webhook Contract' }),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  const auth = { authorization: `Bearer ${token}` };

  response = await req('/api/me', { headers: auth });
  const me = await response.json();
  const orgId = me.orgs[0].id;

  response = await req('/api/projects', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'Webhook retry contract', orgId }),
  });
  assert.equal(response.status, 200);
  const project = await response.json();

  // Persist a legacy/hostile row directly so the delivery boundary, not creation
  // validation, proves it still blocks a non-public target without network I/O.
  const webhookId = rowid(db.prepare(
    'INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)'
  ).run(orgId, 'https://127.0.0.1/internal', 'whsec_test_contract', 'project.update'));

  response = await req(`/api/projects/${project.id}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ tasks: [{ id: 'webhook', name: 'retry' }], version: project.version }),
  });
  assert.equal(response.status, 200, 'triggering request remains successful');

  let deliveries = [];
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    response = await req(`/api/orgs/${orgId}/webhooks/${webhookId}/deliveries`, { headers: auth });
    assert.equal(response.status, 200);
    deliveries = (await response.json()).deliveries;
    if (deliveries.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(deliveries.length, 2, 'one initial failure and exactly one retry are recorded');
  assert.deepEqual(new Set(deliveries.map((delivery) => delivery.attempt)), new Set([1, 2]));
  assert.ok(deliveries.every((delivery) => delivery.ok === 0));
  assert.ok(deliveries.every((delivery) => delivery.statusCode === null));
});
