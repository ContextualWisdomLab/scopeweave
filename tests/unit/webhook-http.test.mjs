import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  WebhookTargetBlockedError,
  postPinnedWebhook,
} from '../../server/webhook_http.mjs';

function fakeTransport(assertLookup) {
  return (_url, options, onResponse) => {
    assertLookup(options.lookup);
    const request = new EventEmitter();
    request.end = (body) => {
      assert.equal(body, '{"event":"project.update"}');
      const response = new EventEmitter();
      response.statusCode = 204;
      response.resume = () => {};
      queueMicrotask(() => {
        onResponse(response);
        queueMicrotask(() => response.emit('end'));
      });
    };
    return request;
  };
}

const safeAddresses = [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
];
let resolutionCount = 0;
const response = await postPinnedWebhook(
  'https://webhook.example/hook',
  {
    headers: { 'content-type': 'application/json' },
    body: '{"event":"project.update"}',
  },
  {
    lookupAddresses: async () => {
      resolutionCount++;
      return safeAddresses;
    },
    httpsRequest: fakeTransport((pinnedLookup) => {
      pinnedLookup('webhook.example', { all: true }, (error, addresses) => {
        assert.ifError(error);
        assert.deepEqual(addresses, safeAddresses);
      });
    }),
  },
);
assert.equal(resolutionCount, 1, 'hostname is resolved exactly once');
assert.deepEqual(response, { status: 204, ok: true });

let transportCalled = false;
await assert.rejects(
  postPinnedWebhook(
    'https://webhook.example/hook',
    { body: '{}' },
    {
      lookupAddresses: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      httpsRequest: () => {
        transportCalled = true;
      },
    },
  ),
  WebhookTargetBlockedError,
  'every resolved address must be public',
);
assert.equal(transportCalled, false, 'blocked targets never reach the transport');

await assert.rejects(
  postPinnedWebhook(
    'https://webhook.example/hook',
    { body: '{}' },
    { lookupAddresses: async () => [] },
  ),
  WebhookTargetBlockedError,
  'empty DNS answers fail closed',
);

await assert.rejects(
  postPinnedWebhook('http://[::ffff:127.0.0.1]/hook', { body: '{}' }),
  WebhookTargetBlockedError,
  'IPv4-mapped loopback addresses are blocked',
);

console.log('webhook HTTP SSRF tests passed');
