import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  WebhookDestinationError,
  createWebhookTransport,
} from '../../server/webhook_transport.mjs';

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

const devCapture = {};
let httpsCalls = 0;
const devTransport = createWebhookTransport({
  allowDevelopmentLoopback: true,
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  request: () => {
    httpsCalls += 1;
    throw new Error('HTTPS connector must not receive a development HTTP loopback');
  },
  httpRequest: responseRequest(204, devCapture),
});

assert.deepEqual(
  await devTransport.post('http://127.0.0.1:8788/hook', {
    headers: { 'x-scopeweave-event': 'project.update' },
    body: '{"ok":true}',
  }),
  { status: 204, ok: true },
  'a loopback URL admitted in development mode is also deliverable',
);
assert.equal(httpsCalls, 0, 'development HTTP loopback never uses the HTTPS connector');
assert.equal(devCapture.url.protocol, 'http:');
assert.equal(devCapture.url.hostname, '127.0.0.1');
assert.equal(devCapture.options.method, 'POST');
assert.equal(devCapture.options.agent, false);
assert.equal('servername' in devCapture.options, false, 'development HTTP does not configure TLS SNI');
assert.equal(devCapture.body, '{"ok":true}');

const productionTransport = createWebhookTransport({
  allowDevelopmentLoopback: false,
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  request: responseRequest(204),
  httpRequest: responseRequest(204),
});
await assert.rejects(
  () => productionTransport.post('http://127.0.0.1:8788/hook'),
  WebhookDestinationError,
  'the loopback exception remains unavailable outside explicit development mode',
);

let privateConnectorCalls = 0;
const privateHostnameTransport = createWebhookTransport({
  allowDevelopmentLoopback: true,
  lookup: async () => [{ address: '10.0.0.5', family: 4 }],
  request: responseRequest(204),
  httpRequest: (...args) => {
    privateConnectorCalls += 1;
    return responseRequest(204)(...args);
  },
});
await assert.rejects(
  () => privateHostnameTransport.post('http://localhost:8788/hook'),
  WebhookDestinationError,
  'development localhost may resolve only to loopback addresses',
);
assert.equal(privateConnectorCalls, 0, 'a non-loopback localhost answer never reaches a connector');

console.log('webhook development loopback transport tests passed');
