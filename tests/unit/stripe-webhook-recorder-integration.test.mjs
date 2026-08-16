import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  StripeWebhookLedgerError,
  configureStripeWebhookEventRecorder,
} from '../../server/stripe_webhook_event_ledger.mjs';
import {
  StripeWebhookError,
  verifyStripeWebhookRequest,
} from '../../server/stripe_webhook.mjs';

const SECRET = 'whsec_scopeweave_recorder_unit';
const NOW_SECONDS = 1_787_000_100;

function body(id = 'evt_recorder_1') {
  return JSON.stringify({
    id,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: 1_787_000_000,
    type: 'customer.subscription.updated',
    request: { id: 'req_recorder_1', idempotency_key: null },
    data: { object: { id: 'sub_recorder_1', object: 'subscription' } },
  });
}

function requestFor(rawBody) {
  const signature = createHmac('sha256', SECRET)
    .update(String(NOW_SECONDS))
    .update('.')
    .update(rawBody)
    .digest('hex');
  return new Request('https://scopeweave.example/api/stripe/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${NOW_SECONDS},v1=${signature}`,
    },
    body: rawBody,
  });
}

test('pure verifier exposes exact-byte hash evidence without requiring runtime persistence', async () => {
  const rawBody = body();
  const verified = await verifyStripeWebhookRequest(requestFor(rawBody), {
    secret: SECRET,
    nowSeconds: NOW_SECONDS,
    includeEvidence: true,
  });
  assert.equal(verified.event.id, 'evt_recorder_1');
  assert.equal(verified.payloadSha256, createHash('sha256').update(rawBody).digest('hex'));
});

test('runtime recorder configuration validates and receives verified exact-byte evidence', async () => {
  assert.throws(() => configureStripeWebhookEventRecorder(null), TypeError);
  let captured;
  configureStripeWebhookEventRecorder((evidence) => { captured = evidence; });

  const rawBody = body('evt_recorder_2');
  const event = await verifyStripeWebhookRequest(requestFor(rawBody), {
    secret: SECRET,
    nowSeconds: NOW_SECONDS,
  });
  assert.equal(event.id, 'evt_recorder_2');
  assert.equal(captured.event.id, 'evt_recorder_2');
  assert.equal(captured.payloadSha256, createHash('sha256').update(rawBody).digest('hex'));
});

test('known ledger failures keep stable sanitized status while unknown persistence failures become unavailable', async () => {
  configureStripeWebhookEventRecorder(() => {
    throw new StripeWebhookLedgerError('stripe_webhook_event_conflict', 409);
  });
  await assert.rejects(
    verifyStripeWebhookRequest(requestFor(body('evt_conflict')), { secret: SECRET, nowSeconds: NOW_SECONDS }),
    (error) => error instanceof StripeWebhookError && error.code === 'stripe_webhook_event_conflict' && error.status === 409,
  );

  configureStripeWebhookEventRecorder(() => { throw new Error('database path intentionally hidden'); });
  await assert.rejects(
    verifyStripeWebhookRequest(requestFor(body('evt_unavailable')), { secret: SECRET, nowSeconds: NOW_SECONDS }),
    (error) => error instanceof StripeWebhookError && error.code === 'stripe_webhook_persistence_unavailable' && error.status === 503,
  );
});
