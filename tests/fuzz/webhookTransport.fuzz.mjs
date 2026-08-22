// Property regression: the outbound webhook transport owns HTTP framing for
// the exact body bytes it writes. Caller-supplied Content-Length is untrusted
// metadata and must never be forwarded when it can disagree with that body.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fc from 'fast-check';
import { createWebhookTransport } from '../../server/webhook_transport.mjs';

const RUNS = Math.min(Number(process.env.FUZZ_RUNS || 3000), 500);

test('webhook transport strips caller-supplied Content-Length before writing the body', async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 128 }), async (body) => {
      let capturedOptions;
      const transport = createWebhookTransport({
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        request: (_url, options, callback) => {
          capturedOptions = options;
          const req = new EventEmitter();
          req.end = (sentBody) => {
            assert.equal(sentBody, body);
            callback({ statusCode: 204, resume() {} });
          };
          return req;
        },
      });

      const result = await transport.post('https://hooks.example.com/events', {
        headers: {
          'content-length': String(Buffer.byteLength(body) + 1),
          'x-scopeweave-test': 'framing-owner',
        },
        body,
      });

      assert.equal(result.status, 204);
      assert.equal(capturedOptions.headers['content-length'], undefined);
      assert.equal(capturedOptions.headers['x-scopeweave-test'], 'framing-owner');
    }),
    { numRuns: RUNS },
  );
});
