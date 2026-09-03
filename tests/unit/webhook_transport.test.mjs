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
