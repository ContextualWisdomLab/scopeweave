import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createValidatedLookup, postWebhook, validateWebhookUrl } from '../../server/webhook_delivery.mjs';

const accepted = [
  'https://example.com/hook',
  'https://192.168.example.com/hook',
  'https://8.8.8.8/hook',
  'https://example.com./hook',
];
for (const value of accepted) assert.equal(validateWebhookUrl(value).protocol, 'https:');

for (const value of [
  null,
  'not a url',
  'http://example.com/hook',
  'https://user:password@example.com/hook',
  'https://localhost/hook',
  'https://api.localhost./hook',
  'https://127.1/hook',
  'https://10.1.2.3/hook',
  'https://169.254.169.254/latest/meta-data/',
  'https://172.16.0.1/hook',
  'https://192.168.0.1/hook',
  'https://198.18.0.1/hook',
  'https://[::1]/hook',
  'https://[fc00::1]/hook',
  'https://[fe80::1]/hook',
  'https://[::ffff:127.0.0.1]/hook',
]) assert.throws(() => validateWebhookUrl(value), { name: 'Error' }, `${value} must fail closed`);

function lookupResult(lookup, hostname, options) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

const safeResolver = (_host, options, callback) => {
  assert.equal(options.all, true);
  assert.equal(options.order, 'verbatim');
  callback(null, [
    { address: '8.8.8.8', family: 4 },
    { address: '2001:4860:4860::8888', family: 6 },
  ]);
};
const safeLookup = createValidatedLookup(safeResolver);
assert.deepEqual(await lookupResult(safeLookup, 'example.com', 4), { address: '8.8.8.8', family: 4 });
const allResult = await lookupResult(safeLookup, 'example.com', { all: true });
assert.deepEqual(allResult.address, [
  { address: '8.8.8.8', family: 4 },
  { address: '2001:4860:4860::8888', family: 6 },
]);
assert.equal(allResult.family, undefined);

await assert.rejects(
  lookupResult(createValidatedLookup((_host, _options, callback) => callback(new Error('resolver down'))), 'example.com', {}),
  /resolver down/,
);
await assert.rejects(
  lookupResult(createValidatedLookup((_host, _options, callback) => callback(null, [])), 'example.com', {}),
  /no webhook destination/,
);
await assert.rejects(
  lookupResult(createValidatedLookup((_host, _options, callback) => callback(null, [
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ])), 'example.com', {}),
  /not globally routable/,
);
await assert.rejects(
  lookupResult(createValidatedLookup((_host, _options, callback) => callback(null, { address: '8.8.8.8', family: 4 })), 'example.com', { family: 6 }),
  /requested family/,
);
await assert.rejects(
  lookupResult(createValidatedLookup((_host, _options, callback) => callback(null, { address: 'not-an-ip', family: 4 })), 'example.com', {}),
  /non-IP/,
);

function fakeRequestFactory(statusCode = 204, { emitError = null } = {}) {
  const calls = [];
  const request = (url, options, onResponse) => {
    const emitter = new EventEmitter();
    const call = { url: url.toString(), options, body: null, timeoutMs: null, destroyed: null };
    calls.push(call);
    emitter.setTimeout = (timeoutMs, callback) => { call.timeoutMs = timeoutMs; call.timeout = callback; };
    emitter.destroy = (error) => { call.destroyed = error; emitter.emit('error', error); };
    emitter.end = (body) => {
      call.body = body;
      if (emitError) return queueMicrotask(() => emitter.emit('error', emitError));
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.resume = () => { call.resumed = true; };
      queueMicrotask(() => onResponse(response));
    };
    return emitter;
  };
  return { request, calls };
}

const successTransport = fakeRequestFactory(204);
assert.deepEqual(await postWebhook('https://example.com/hook', {
  headers: { 'x-test': '1' },
  body: '{"ok":true}',
  timeoutMs: 1234,
  lookup: safeResolver,
  request: successTransport.request,
}), { status: 204, ok: true });
assert.equal(successTransport.calls.length, 1);
assert.equal(successTransport.calls[0].options.method, 'POST');
assert.equal(successTransport.calls[0].options.agent, false);
assert.equal(typeof successTransport.calls[0].options.lookup, 'function');
assert.equal(successTransport.calls[0].timeoutMs, 1234);
assert.equal(successTransport.calls[0].body, '{"ok":true}');
assert.equal(successTransport.calls[0].resumed, true);

const redirectTransport = fakeRequestFactory(302);
assert.deepEqual(await postWebhook('https://example.com/redirect', {
  lookup: safeResolver,
  request: redirectTransport.request,
}), { status: 302, ok: false });
assert.equal(redirectTransport.calls.length, 1, 'redirect is a terminal response, never followed');

const zeroStatusTransport = fakeRequestFactory(undefined);
assert.deepEqual(await postWebhook('https://example.com/no-status', {
  lookup: safeResolver,
  request: zeroStatusTransport.request,
}), { status: 0, ok: false });

const networkFailure = new Error('socket failed');
const failingTransport = fakeRequestFactory(500, { emitError: networkFailure });
await assert.rejects(postWebhook('https://example.com/fail', {
  lookup: safeResolver,
  request: failingTransport.request,
}), /socket failed/);

const timeoutTransport = fakeRequestFactory(204);
const timed = postWebhook('https://example.com/timeout', {
  timeoutMs: 5,
  lookup: safeResolver,
  request: timeoutTransport.request,
});
timeoutTransport.calls[0].timeout();
await assert.rejects(timed, /timed out/);
assert.match(timeoutTransport.calls[0].destroyed.message, /timed out/);

console.log('webhook delivery unit tests passed');
