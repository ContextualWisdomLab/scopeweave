// Property regression: the outbound webhook transport owns HTTP framing for
// the exact body bytes it writes. Caller-supplied Content-Length is untrusted
// metadata and must never be forwarded when it can disagree with that body.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fc from 'fast-check';
import { createWebhookTransport } from '../../server/webhook_transport.mjs';

const DEFAULT_RUNS = 3000;
const MAX_RUNS = 200000;

const requestedRuns = (value) => {
  if (value === undefined || value === '') return DEFAULT_RUNS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RUNS;
  return Math.min(parsed, MAX_RUNS);
};
const RUNS = requestedRuns(process.env.FUZZ_RUNS);

test('fuzz iteration budget preserves the documented default and workflow budgets', () => {
  assert.equal(requestedRuns(undefined), 3000, 'local default stays at 3000 property cases');
  assert.equal(requestedRuns('20000'), 20000, 'pull-request workflow budget is honored');
  assert.equal(requestedRuns('200000'), 200000, 'scheduled workflow budget is honored');
  assert.equal(requestedRuns('200001'), 200000, 'operator input is bounded by the scheduled budget ceiling');
  assert.equal(requestedRuns('0'), 3000, 'zero falls back to the safe local default');
  assert.equal(requestedRuns('-1'), 3000, 'negative values fall back to the safe local default');
  assert.equal(requestedRuns('not-a-number'), 3000, 'invalid values fall back to the safe local default');
});

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
