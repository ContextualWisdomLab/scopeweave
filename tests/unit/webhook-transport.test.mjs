import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  WebhookDestinationError,
  WebhookTransportError,
  createWebhookTransport,
  isPublicWebhookAddress,
  validateWebhookRegistrationUrl,
} from '../../server/webhook_transport.mjs';

assert.equal(isPublicWebhookAddress('8.8.8.8'), true);
assert.equal(isPublicWebhookAddress('2606:4700:4700::1111'), true);
for (const address of [
  'not-an-ip', '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1',
  '169.254.169.254', '172.16.0.1', '192.0.2.10', '192.31.196.1',
  '192.52.193.1', '192.168.1.1', '192.175.48.1', '198.18.0.1',
  '198.51.100.2', '203.0.113.9', '224.0.0.1', '255.255.255.255',
  '::', '::1', '::ffff:127.0.0.1', '64:ff9b::1', '100::1',
  '100:0:0:1::1', '2001::1', '2001:2::1', '2001:db8::1', '2002::1',
  '2620:4f:8000::1', '3ffe::1', '3fff::1', '400::1', '4000::1',
  '5f00::1', 'fc00::1', 'fec0::1', 'fe80::1', 'ff00::1',
]) {
  assert.equal(isPublicWebhookAddress(address), false, `${address} is denied`);
}

assert.equal(
  validateWebhookRegistrationUrl('https://hooks.example.com/scopeweave?tenant=buyer'),
  'https://hooks.example.com/scopeweave?tenant=buyer',
);
assert.equal(validateWebhookRegistrationUrl('https://8.8.8.8/hook'), 'https://8.8.8.8/hook');
assert.equal(
  validateWebhookRegistrationUrl('https://[2606:4700:4700::1111]/hook'),
  'https://[2606:4700:4700::1111]/hook',
);
for (const url of [
  '', 'not a url', 'http://example.com/hook',
  'https://user:pass@example.com/hook', 'https://example.com/hook#fragment',
  'https://localhost/hook', 'https://api.localhost/hook', 'https://printer.local/hook',
  'https://home.arpa/hook', 'https://svc.home.arpa/hook', 'https://127.0.0.1/hook',
  'https://2130706433/hook', 'https://0x7f000001/hook',
  'https://[::1]/hook', 'https://[::ffff:127.0.0.1]/hook',
]) {
  assert.throws(
    () => validateWebhookRegistrationUrl(url),
    WebhookDestinationError,
    `${url} is rejected`,
  );
}
assert.throws(() => createWebhookTransport({ lookup: null }), TypeError);
assert.throws(() => createWebhookTransport({ request: null }), TypeError);

function responseRequest(statusCode, capture = {}) {
  return (url, options, callback) => {
    capture.url = url;
    capture.options = options;
    capture.calls = (capture.calls || 0) + 1;
    const req = new EventEmitter();
    req.end = (body) => {
      capture.body = body;
      queueMicrotask(() => callback({
        statusCode,
        resume() { capture.resumed = true; },
      }));
    };
    return req;
  };
}

const capture = {};
const publicTransport = createWebhookTransport({
  lookup: async (hostname, options) => {
    assert.equal(hostname, 'hooks.example.com');
    assert.deepEqual(options, { all: true, verbatim: true });
    return [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
  },
  request: responseRequest(204, capture),
});
const sent = await publicTransport.post('https://hooks.example.com/a?x=1', {
  headers: { 'x-test': 'yes' },
  body: '{"ok":true}',
});
assert.deepEqual(sent, { status: 204, ok: true });
assert.equal(capture.url.hostname, 'hooks.example.com');
assert.equal(capture.options.method, 'POST');
assert.equal(capture.options.agent, false);
assert.equal(capture.options.servername, 'hooks.example.com');
assert.deepEqual(capture.options.headers, { 'x-test': 'yes' });
assert.equal(capture.body, '{"ok":true}');
assert.equal(capture.resumed, true);
await new Promise((resolve, reject) => {
  capture.options.lookup('ignored.example', {}, (error, address, family) => {
    try {
      assert.equal(error, null);
      assert.equal(address, '93.184.216.34');
      assert.equal(family, 4);
      resolve();
    } catch (e) { reject(e); }
  });
});
await new Promise((resolve, reject) => {
  capture.options.lookup('ignored.example', { all: true }, (error, addresses) => {
    try {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
      resolve();
    } catch (e) { reject(e); }
  });
});

const redirectCapture = {};
const redirectTransport = createWebhookTransport({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  request: responseRequest(302, redirectCapture),
});
assert.deepEqual(
  await redirectTransport.post('https://hooks.example.com/redirect'),
  { status: 302, ok: false },
);
assert.equal(redirectCapture.calls, 1, 'native HTTPS does not follow redirects');

for (const answers of [
  [{ address: '127.0.0.1', family: 4 }],
  [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.4', family: 4 }],
  [{ address: 'bad-address', family: 4 }],
  [{ address: '93.184.216.34', family: 7 }],
]) {
  let requestCalls = 0;
  const transport = createWebhookTransport({
    lookup: async () => answers,
    request: (...args) => {
      requestCalls++;
      return responseRequest(200)(...args);
    },
  });
  await assert.rejects(
    () => transport.post('https://hooks.example.com/hook'),
    WebhookDestinationError,
  );
  assert.equal(requestCalls, 0, 'denied DNS answers never reach the connector');
}

for (const answers of [[], null]) {
  const transport = createWebhookTransport({
    lookup: async () => answers,
    request: responseRequest(200),
  });
  await assert.rejects(
    () => transport.post('https://hooks.example.com/hook'),
    WebhookTransportError,
  );
}
const dnsFailure = createWebhookTransport({
  lookup: async () => { throw new Error('lookup 10.0.0.1 failed'); },
  request: responseRequest(200),
});
await assert.rejects(
  () => dnsFailure.post('https://hooks.example.com/hook'),
  (error) => error instanceof WebhookTransportError
    && error.message === 'webhook destination unavailable'
    && !error.message.includes('10.0.0.1'),
);

let generation = 0;
let reboundRequests = 0;
const rebindingTransport = createWebhookTransport({
  lookup: async () => (++generation === 1
    ? [{ address: '93.184.216.34', family: 4 }]
    : [{ address: '127.0.0.1', family: 4 }]),
  request: (...args) => {
    reboundRequests++;
    return responseRequest(503)(...args);
  },
});
assert.deepEqual(
  await rebindingTransport.post('https://hooks.example.com/hook'),
  { status: 503, ok: false },
);
await assert.rejects(
  () => rebindingTransport.post('https://hooks.example.com/hook'),
  WebhookDestinationError,
);
assert.equal(
  reboundRequests,
  1,
  'a later private DNS answer is rejected before a retry connection',
);

let literalLookupCalls = 0;
const literalCapture = {};
const literalTransport = createWebhookTransport({
  lookup: async () => {
    literalLookupCalls++;
    return [];
  },
  request: responseRequest(200, literalCapture),
});
assert.deepEqual(
  await literalTransport.post('https://8.8.8.8/hook'),
  { status: 200, ok: true },
);
assert.equal(literalLookupCalls, 0);
assert.equal(
  'servername' in literalCapture.options,
  false,
  'IP literals do not inject an SNI hostname',
);

const syncFailure = createWebhookTransport({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  request: () => { throw new Error('secret network detail'); },
});
await assert.rejects(
  () => syncFailure.post('https://hooks.example.com/hook'),
  WebhookTransportError,
);

const emittedFailure = createWebhookTransport({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  request: () => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => req.emit('error', new Error('socket 10.0.0.1')));
    return req;
  },
});
await assert.rejects(
  () => emittedFailure.post('https://hooks.example.com/hook'),
  WebhookTransportError,
);

const controller = new AbortController();
controller.abort();
const aborted = createWebhookTransport({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  request: responseRequest(200),
});
await assert.rejects(
  () => aborted.post('https://hooks.example.com/hook', { signal: controller.signal }),
  WebhookTransportError,
);

console.log('webhook transport policy tests passed');
