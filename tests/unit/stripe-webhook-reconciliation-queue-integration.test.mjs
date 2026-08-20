import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

process.env.SCOPEWEAVE_DB = ':memory:';

const { db } = await import('../../server/db.mjs');
const { verifyStripeWebhookRequest } = await import('../../server/stripe_webhook.mjs');

const WEBHOOK_SECRET = 'whsec_scopeweave_queue_test';
const NOW_SECONDS = 1_787_000_100;

function signedRequest(event) {
  const body = JSON.stringify(event);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(String(NOW_SECONDS))
    .update('.')
    .update(body)
    .digest('hex');
  return new Request('https://scopeweave.invalid/api/stripe/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${NOW_SECONDS},v1=${signature}`,
    },
    body,
  });
}

function subscriptionEvent({
  eventId = 'evt_queue_subscription',
  subscriptionId = 'sub_queue_subscription',
} = {}) {
  return {
    id: eventId,
    object: 'event',
    api_version: '2025-03-31.basil',
    created: NOW_SECONDS - 1,
    type: 'customer.subscription.updated',
    request: null,
    data: {
      object: {
        id: subscriptionId,
        object: 'subscription',
      },
    },
  };
}

function oneOffInvoiceEvent() {
  return {
    id: 'evt_queue_one_off_invoice',
    object: 'event',
    api_version: '2025-03-31.basil',
    created: NOW_SECONDS - 1,
    type: 'invoice.paid',
    request: null,
    data: {
      object: {
        id: 'in_queue_one_off',
        object: 'invoice',
        parent: null,
      },
    },
  };
}

test('production webhook bootstrap durably queues a verified Subscription trigger', async () => {
  const event = subscriptionEvent();
  const verified = await verifyStripeWebhookRequest(signedRequest(event), {
    secret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });
  assert.equal(verified.id, event.id);

  assert.deepEqual(db.prepare(`
    SELECT event_id, subscription_id, processing_state
      FROM billing_stripe_reconciliation_triggers
     WHERE event_id = ?
  `).get(event.id), {
    event_id: event.id,
    subscription_id: 'sub_queue_subscription',
    processing_state: 'pending',
  });
});

test('exact verified webhook redelivery records delivery evidence without duplicating queued work', async () => {
  const event = subscriptionEvent({
    eventId: 'evt_queue_redelivery',
    subscriptionId: 'sub_queue_redelivery',
  });
  await verifyStripeWebhookRequest(signedRequest(event), {
    secret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });
  await verifyStripeWebhookRequest(signedRequest(event), {
    secret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });

  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM billing_stripe_reconciliation_triggers WHERE event_id = ?
  `).get(event.id).count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM billing_stripe_webhook_deliveries WHERE event_id = ?
  `).get(event.id).count, 2);
});

test('verified one-off Invoice evidence is retained without manufacturing Subscription work', async () => {
  const event = oneOffInvoiceEvent();
  await verifyStripeWebhookRequest(signedRequest(event), {
    secret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });

  assert.ok(db.prepare(`
    SELECT event_id FROM billing_stripe_webhook_events WHERE event_id = ?
  `).get(event.id));
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM billing_stripe_reconciliation_triggers WHERE event_id = ?
  `).get(event.id).count, 0);
});
