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

test('application delivery records failed HTTP attempts and retries exactly once without network', async () => {
  process.env.SCOPEWEAVE_DB = ':memory:';
  const { sendWebhook } = await import('../../server/app.mjs');
  assert.equal(typeof sendWebhook, 'function', 'application delivery seam is executable');

  const requests = [];
  const records = [];
  const scheduled = [];
  const runtime = {
    postWebhook: async (request) => {
      requests.push(request);
      return { status: 503, ok: false };
    },
    recordDelivery: (...args) => records.push(args),
    scheduleRetry: (run, delayMs) => scheduled.push({ run, delayMs }),
  };

  await sendWebhook(17, 'https://hooks.example.net/hook', 'deadbeef', 'project.update', '{"ok":true}', 1, runtime);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['x-scopeweave-signature'], 'sha256=deadbeef');
  assert.deepEqual(records, [[17, 'project.update', 503, false, 1]]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 500);

  await scheduled.shift().run();
  assert.equal(requests.length, 2, 'one failed first attempt is retried once');
  assert.deepEqual(records[1], [17, 'project.update', 503, false, 2]);
  assert.equal(scheduled.length, 0, 'second failure does not schedule a third attempt');
});

test('application delivery records transport rejection before the bounded retry', async () => {
  process.env.SCOPEWEAVE_DB = ':memory:';
  const { sendWebhook } = await import('../../server/app.mjs');
  const records = [];
  const scheduled = [];
  const runtime = {
    postWebhook: async () => { throw new Error('connect failed'); },
    recordDelivery: (...args) => records.push(args),
    scheduleRetry: (run, delayMs) => scheduled.push({ run, delayMs }),
  };

  await sendWebhook(18, 'https://hooks.example.net/hook', 'cafebabe', 'project.update', '{}', 1, runtime);
  assert.deepEqual(records, [[18, 'project.update', null, false, 1]]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 500);
});
