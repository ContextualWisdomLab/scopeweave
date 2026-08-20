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
          acceptEncoding: options.headers?.get?.('accept-encoding')
            ?? options.headers?.['accept-encoding'],
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
      acceptEncoding: 'identity',
    },
    {
      ...PUBLIC_B,
      agent: false,
      servername: 'idp.example.test',
      method: 'GET',
      acceptEncoding: 'identity',
    },
  ],
  'every fallback attempt is pinned, disables pooling, preserves SNI, and requests identity encoding',
);

const nullBodyStatusTransport = createPublicHttpsTransport({
  lookup: async () => [PUBLIC_A],
  request: (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = 204;
      response.headers = { 'content-type': 'application/json' };
      response.destroy = () => {};
      callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from('unexpected upstream bytes'));
        response.emit('end');
      });
    };
    return req;
  },
});
const nullBodyResponse = await nullBodyStatusTransport.fetch(
  'https://idp.example.test/no-content',
  { signal: AbortSignal.timeout(250) },
);
assert.equal(nullBodyResponse.status, 204);
assert.equal(await nullBodyResponse.text(), '');

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

let responseStartedAttempts = 0;
const noReplayAfterResponse = createPublicHttpsTransport({
  lookup: async () => [PUBLIC_A, PUBLIC_B],
  request: (_url, options, callback) => {
    responseStartedAttempts += 1;
    const req = new EventEmitter();
    req.end = () => {
      options.lookup('ignored.example', {}, (error, address) => {
        assert.ifError(error);
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json' };
        response.destroy = () => {};
        callback(response);
        queueMicrotask(() => {
          if (address === PUBLIC_A.address) {
            response.emit('data', Buffer.alloc(9));
            return;
          }
          response.emit('data', Buffer.from('{}'));
          response.emit('end');
        });
      });
    };
    return req;
  },
});
await assert.rejects(
  noReplayAfterResponse.fetch('https://idp.example.test/token', {
    method: 'POST',
    body: 'grant_type=authorization_code',
    maxResponseBytes: 8,
  }),
  WebhookTransportError,
  'a response-stream failure must not replay an already-sent POST to another address',
);
assert.equal(
  responseStartedAttempts,
  1,
  'only connection-establishment failures may advance to another validated address',
);

let postTlsAttempts = 0;
const noReplayAfterSecureConnect = createPublicHttpsTransport({
  lookup: async () => [PUBLIC_A, PUBLIC_B],
  request: (_url, options) => {
    postTlsAttempts += 1;
    const req = new EventEmitter();
    req.end = () => {
      options.lookup('ignored.example', {}, (error) => {
        assert.ifError(error);
        const socket = new EventEmitter();
        req.emit('socket', socket);
        queueMicrotask(() => {
          socket.emit('secureConnect');
          queueMicrotask(() => req.emit('error', new Error('peer closed after TLS handshake')));
        });
      });
    };
    return req;
  },
});
await assert.rejects(
  noReplayAfterSecureConnect.fetch('https://idp.example.test/token', {
    method: 'POST',
    body: 'grant_type=authorization_code',
  }),
  WebhookTransportError,
  'a non-idempotent request must not replay after TLS is established even without response headers',
);
assert.equal(
  postTlsAttempts,
  1,
  'a post-handshake failure is ambiguous and must not consume an authorization code twice',
);

await assert.rejects(
  transport.fetch('https://idp.example.test/jwks', { maxResponseBytes: 0 }),
  /positive safe integer/,
);
assert.throws(
  () => createPublicHttpsTransport({ lookup: null }),
  /dependencies must be functions/,
);

console.log('public HTTPS DNS pinning, identity encoding, fallback, and response-bound regressions passed');
