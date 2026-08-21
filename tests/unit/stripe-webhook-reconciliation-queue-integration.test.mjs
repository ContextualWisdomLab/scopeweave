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

function checkoutCompletedEvent({
  eventId = 'evt_queue_checkout_completed',
  sessionId = 'cs_queue_checkout',
  customerId = 'cus_queue_checkout',
  subscriptionId = 'sub_queue_checkout',
} = {}) {
  return {
    id: eventId,
    object: 'event',
    api_version: '2025-03-31.basil',
    created: NOW_SECONDS - 1,
    type: 'checkout.session.completed',
    request: null,
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        mode: 'subscription',
        customer: customerId,
        subscription: subscriptionId,
      },
    },
  };
}

function prepareSucceededCheckout({
  userId = 901,
  organizationId = 901,
  attemptId = 'attempt_queue_checkout',
  sessionId = 'cs_queue_checkout',
  priceId = 'price_queue_checkout',
} = {}) {
  db.prepare(`
    INSERT OR IGNORE INTO users(id, email, password_hash, name)
    VALUES(?,?,?,?)
  `).run(userId, `owner-${userId}@example.invalid`, 'hash', `Owner ${userId}`);
  db.prepare(`
    INSERT OR IGNORE INTO orgs(id, name, owner_id, plan)
    VALUES(?,?,?,'free')
  `).run(organizationId, `Org ${organizationId}`, userId);
  db.prepare(`
    INSERT INTO billing_checkout_attempts(
      attempt_id, organization_id, price_id, idempotency_key, attempt_state,
      provider_session_id, created_at_ms, updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?)
  `).run(
    attemptId,
    organizationId,
    priceId,
    `idem_${attemptId}`,
    'provider_succeeded',
    sessionId,
    NOW_SECONDS * 1000 - 10,
    NOW_SECONDS * 1000 - 5,
  );
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

  const trigger = db.prepare(`
    SELECT event_id, subscription_id, processing_state
      FROM billing_stripe_reconciliation_triggers
     WHERE event_id = ?
  `).get(event.id);
  assert.deepEqual({ ...trigger }, {
    event_id: event.id,
    subscription_id: 'sub_queue_subscription',
    processing_state: 'pending',
  });
});

test('verified Checkout completion bootstraps tenant identity before queuing reconciliation work', async () => {
  prepareSucceededCheckout();
  const event = checkoutCompletedEvent();

  await verifyStripeWebhookRequest(signedRequest(event), {
    secret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });

  assert.deepEqual({ ...db.prepare(`
    SELECT customer_id, organization_id
      FROM billing_stripe_customers
     WHERE customer_id = ?
  `).get('cus_queue_checkout') }, {
    customer_id: 'cus_queue_checkout',
    organization_id: 901,
  });
  assert.deepEqual({ ...db.prepare(`
    SELECT subscription_id, customer_id
      FROM billing_stripe_subscriptions
     WHERE subscription_id = ?
  `).get('sub_queue_checkout') }, {
    subscription_id: 'sub_queue_checkout',
    customer_id: 'cus_queue_checkout',
  });
  assert.deepEqual({ ...db.prepare(`
    SELECT event_id, subscription_id, processing_state
      FROM billing_stripe_reconciliation_triggers
     WHERE event_id = ?
  `).get(event.id) }, {
    event_id: event.id,
    subscription_id: 'sub_queue_checkout',
    processing_state: 'pending',
  });
  assert.equal(db.prepare('SELECT plan FROM orgs WHERE id = 901').get().plan, 'free');
});

test('Checkout identity bootstrap and trigger queue roll back with verified event evidence on downstream failure', async () => {
  prepareSucceededCheckout({
    userId: 902,
    organizationId: 902,
    attemptId: 'attempt_queue_checkout_failure',
    sessionId: 'cs_queue_checkout_failure',
    priceId: 'price_queue_checkout_failure',
  });
  const event = checkoutCompletedEvent({
    eventId: 'evt_queue_checkout_failure',
    sessionId: 'cs_queue_checkout_failure',
    customerId: 'cus_queue_checkout_failure',
    subscriptionId: 'sub_queue_checkout_failure',
  });
  db.exec(`
    CREATE TEMP TRIGGER force_checkout_identity_failure
    BEFORE INSERT ON billing_stripe_subscriptions
    WHEN NEW.subscription_id = 'sub_queue_checkout_failure'
    BEGIN
      SELECT RAISE(ABORT, 'forced checkout identity failure');
    END;
  `);

  try {
    await assert.rejects(
      verifyStripeWebhookRequest(signedRequest(event), {
        secret: WEBHOOK_SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    );
  } finally {
    db.exec('DROP TRIGGER force_checkout_identity_failure');
  }

  for (const [table, column] of [
    ['billing_stripe_webhook_events', 'event_id'],
    ['billing_stripe_webhook_deliveries', 'event_id'],
    ['billing_stripe_reconciliation_triggers', 'event_id'],
  ]) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(event.id).count,
      0,
    );
  }
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_customers WHERE customer_id = ?')
      .get('cus_queue_checkout_failure').count,
    0,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_subscriptions WHERE subscription_id = ?')
      .get('sub_queue_checkout_failure').count,
    0,
  );
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

test('verified event evidence and its reconciliation trigger commit atomically', async () => {
  const event = subscriptionEvent({
    eventId: 'evt_queue_atomic_failure',
    subscriptionId: 'sub_queue_atomic_failure',
  });
  db.exec(`
    CREATE TEMP TRIGGER billing_stripe_reconciliation_force_failure
    BEFORE INSERT ON billing_stripe_reconciliation_triggers
    WHEN NEW.event_id = 'evt_queue_atomic_failure'
    BEGIN
      SELECT RAISE(ABORT, 'forced reconciliation queue failure');
    END;
  `);

  try {
    await assert.rejects(
      verifyStripeWebhookRequest(signedRequest(event), {
        secret: WEBHOOK_SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    );
  } finally {
    db.exec('DROP TRIGGER billing_stripe_reconciliation_force_failure');
  }

  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM billing_stripe_webhook_events WHERE event_id = ?
  `).get(event.id).count, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM billing_stripe_webhook_deliveries WHERE event_id = ?
  `).get(event.id).count, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM billing_stripe_reconciliation_triggers WHERE event_id = ?
  `).get(event.id).count, 0);
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
