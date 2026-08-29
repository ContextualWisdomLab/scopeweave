import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  PublicHttpsDestinationError,
  PublicHttpsTransportError,
  configurePublicHttpsTransportForTests,
  createPublicHttpsTransport,
  fetchPublicHttps,
  isPublicInternetAddress,
  validatePublicHttpsUrl,
} from '../../server/public_https_transport.mjs';

const PUBLIC_A = { address: '93.184.216.34', family: 4 };
const PUBLIC_B = { address: '93.184.216.35', family: 4 };

assert.equal(isPublicInternetAddress('93.184.216.34'), true);
assert.equal(isPublicInternetAddress('127.0.0.1'), false);
assert.equal(isPublicInternetAddress('::1'), false);
assert.equal(isPublicInternetAddress('not-an-ip'), false);
assert.throws(() => validatePublicHttpsUrl('http://example.com'), PublicHttpsDestinationError);
assert.throws(() => validatePublicHttpsUrl('https://localhost/path'), PublicHttpsDestinationError);
assert.throws(() => validatePublicHttpsUrl('https://127.0.0.1/path'), PublicHttpsDestinationError);
assert.equal(validatePublicHttpsUrl('https://example.com/a'), 'https://example.com/a');

await assert.rejects(
  createPublicHttpsTransport({
    lookup: async () => [PUBLIC_A, { address: '10.0.0.8', family: 4 }],
    request: () => { throw new Error('request must not run after mixed DNS'); },
  }).fetch('https://idp.example.test/.well-known/openid-configuration'),
  PublicHttpsDestinationError,
);

const attempts = [];
const transport = createPublicHttpsTransport({
  lookup: async () => [PUBLIC_A, PUBLIC_A, PUBLIC_B],
  request: (_url, options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      options.lookup('ignored.example', {}, (error, address, family) => {
        assert.ifError(error);
        attempts.push({ address, family, agent: options.agent, servername: options.servername, method: options.method });
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
const response = await transport.fetch('https://idp.example.test/.well-known/openid-configuration');
assert.deepEqual(await response.json(), { issuer: 'https://idp.example.test' });
assert.deepEqual(attempts.map(({ address }) => address), [PUBLIC_A.address, PUBLIC_B.address]);
assert.equal(attempts[1].agent, false);
assert.equal(attempts[1].servername, 'idp.example.test');
assert.equal(attempts[1].method, 'GET');

const noContent = createPublicHttpsTransport({
  lookup: async () => [PUBLIC_A],
  request: (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const upstream = new EventEmitter();
      upstream.statusCode = 204;
      upstream.headers = {};
      upstream.destroy = () => {};
      callback(upstream);
      queueMicrotask(() => { upstream.emit('data', Buffer.from('ignored')); upstream.emit('end'); });
    };
    return req;
  },
});
assert.equal(await (await noContent.fetch('https://idp.example.test/empty')).text(), '');

let encodedBody;
const formBodyTransport = createPublicHttpsTransport({
  lookup: async () => [PUBLIC_A],
  request: (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = (body) => {
      encodedBody = body;
      const upstream = new EventEmitter();
      upstream.statusCode = 200;
      upstream.headers = {};
      callback(upstream);
      queueMicrotask(() => upstream.emit('end'));
    };
    return req;
  },
});
await formBodyTransport.fetch('https://idp.example.test/token', {
  method: 'POST',
  body: new URLSearchParams({ code: 'one-time', redirect_uri: 'https://scopeweave.example/callback' }),
});
assert.ok(Buffer.isBuffer(encodedBody));
assert.equal(
  encodedBody.toString('utf8'),
  'code=one-time&redirect_uri=https%3A%2F%2Fscopeweave.example%2Fcallback',
  'URLSearchParams bodies are serialized as UTF-8 bytes before transport',
);

const oversized = createPublicHttpsTransport({
  lookup: async () => [PUBLIC_A],
  request: (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const upstream = new EventEmitter();
      upstream.statusCode = 200;
      upstream.headers = {};
      upstream.destroy = () => {};
      callback(upstream);
      queueMicrotask(() => upstream.emit('data', Buffer.alloc(9)));
    };
    return req;
  },
});
await assert.rejects(oversized.fetch('https://idp.example.test/jwks', { maxResponseBytes: 8 }), PublicHttpsTransportError);

let mutatingAttempts = 0;
const noPostReplay = createPublicHttpsTransport({
  lookup: async () => [PUBLIC_A, PUBLIC_B],
  request: (_url, options) => {
    mutatingAttempts += 1;
    const req = new EventEmitter();
    req.end = () => {
      options.lookup('ignored.example', {}, (error) => {
        assert.ifError(error);
        const socket = new EventEmitter();
        req.emit('socket', socket);
        queueMicrotask(() => {
          socket.emit('secureConnect');
          queueMicrotask(() => req.emit('error', new Error('closed after TLS')));
        });
      });
    };
    return req;
  },
});
await assert.rejects(noPostReplay.fetch('https://idp.example.test/token', {
  method: 'POST',
  headers: { 'content-length': '9999' },
  body: new URLSearchParams({ code: 'one-time' }).toString(),
}), PublicHttpsTransportError);
assert.equal(mutatingAttempts, 1);

await assert.rejects(transport.fetch('https://idp.example.test/jwks', { maxResponseBytes: 0 }), /positive safe integer/);
assert.throws(() => createPublicHttpsTransport({ lookup: null }), /dependencies must be functions/);

const controller = new AbortController();
controller.abort();
await assert.rejects(transport.fetch('https://idp.example.test/jwks', { signal: controller.signal }), PublicHttpsTransportError);

delete process.env.NODE_ENV;
assert.throws(
  () => configurePublicHttpsTransportForTests({ fetch() {} }),
  /test-only/,
);
process.env.NODE_ENV = 'test';
let injectedCalls = 0;
configurePublicHttpsTransportForTests({
  async fetch(url) {
    injectedCalls += 1;
    return Response.json({ url: String(url) });
  },
});
assert.deepEqual(await (await fetchPublicHttps('https://example.com/test')).json(), { url: 'https://example.com/test' });
assert.equal(injectedCalls, 1);
assert.throws(() => configurePublicHttpsTransportForTests({}), /must expose fetch/);

console.log('public HTTPS destination, DNS pinning, replay, and response-bound regressions passed');
