import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  WebhookDestinationError,
  WebhookTransportError,
  createPublicHttpsTransport,
} from '../../server/webhook_transport.mjs';

const PUBLIC_A = { address: '93.184.216.34', family: 4 };
const PUBLIC_B = { address: '93.184.216.35', family: 4 };

await assert.rejects(
  createPublicHttpsTransport({
    lookup: async () => [PUBLIC_A, { address: '10.0.0.8', family: 4 }],
    request: () => {
      throw new Error('request must not run after mixed public/private DNS');
    },
  }).fetch('https://idp.example.test/.well-known/openid-configuration'),
  WebhookDestinationError,
  'metadata transport fails closed when any current DNS answer is private',
);

const attempts = [];
const transport = createPublicHttpsTransport({
  lookup: async () => [PUBLIC_A, PUBLIC_B],
  request: (_url, options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      options.lookup('ignored.example', {}, (error, address, family) => {
        assert.ifError(error);
        attempts.push({
          address,
          family,
          agent: options.agent,
          servername: options.servername,
          method: options.method,
        });
        if (address === PUBLIC_A.address) {
          queueMicrotask(() => req.emit('error', new Error('simulated first-address failure')));
          return;
        }
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json' };
        response.destroy = () => {};
        callback(response);
        queueMicrotask(() => {
          response.emit('data', Buffer.from('{"issuer":"https://idp.example.test"}'));
          response.emit('end');
        });
      });
    };
    return req;
  },
});

const response = await transport.fetch(
  'https://idp.example.test/.well-known/openid-configuration',
);
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { issuer: 'https://idp.example.test' });
assert.deepEqual(
  attempts,
  [
    {
      ...PUBLIC_A,
      agent: false,
      servername: 'idp.example.test',
      method: 'GET',
    },
    {
      ...PUBLIC_B,
      agent: false,
      servername: 'idp.example.test',
      method: 'GET',
    },
  ],
  'every fallback attempt is pinned to a validated address with pooling disabled and original SNI preserved',
);

const oversized = createPublicHttpsTransport({
  lookup: async () => [PUBLIC_A],
  request: (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.destroy = () => {};
      callback(response);
      queueMicrotask(() => response.emit('data', Buffer.alloc(9)));
    };
    return req;
  },
});
await assert.rejects(
  oversized.fetch('https://idp.example.test/jwks', { maxResponseBytes: 8 }),
  WebhookTransportError,
  'provider responses larger than the configured memory budget fail closed',
);

await assert.rejects(
  transport.fetch('https://idp.example.test/jwks', { maxResponseBytes: 0 }),
  /positive safe integer/,
);
assert.throws(
  () => createPublicHttpsTransport({ lookup: null }),
  /dependencies must be functions/,
);

console.log('public HTTPS DNS pinning, fallback, and response-bound regressions passed');
