import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  WebhookTransportError,
  createWebhookTransport,
} from '../../server/webhook_transport.mjs';

let capturedTimeout;
let destroyCalls = 0;
const transport = createWebhookTransport({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  request: (_url, options) => {
    capturedTimeout = options.timeout;
    const request = new EventEmitter();
    request.destroy = () => {
      destroyCalls += 1;
      queueMicrotask(() => request.emit('error', new Error('simulated stalled peer')));
    };
    request.end = () => {
      queueMicrotask(() => {
        if (options.timeout === undefined) {
          request.emit('error', new Error('transport omitted its default timeout'));
          return;
        }
        request.emit('timeout');
      });
    };
    return request;
  },
});

await assert.rejects(
  () => transport.post('https://hooks.example.com/stalled', {
    body: '{"event":"project.update"}',
  }),
  WebhookTransportError,
  'a stalled destination fails closed even when the caller supplies no AbortSignal',
);
assert.equal(capturedTimeout, 3000, 'transport owns a three-second default request timeout');
assert.equal(destroyCalls, 1, 'the timeout actively destroys the stalled request');

console.log('webhook default timeout regression passed');
