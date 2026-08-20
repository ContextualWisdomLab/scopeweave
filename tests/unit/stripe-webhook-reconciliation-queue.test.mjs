import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { installStripeWebhookEventSchema } from '../../server/stripe_webhook_event_ledger.mjs';
import {
  StripeWebhookReconciliationQueueError,
  createSqliteStripeWebhookReconciliationQueue,
  extractStripeSubscriptionReconciliationCandidate,
  installStripeWebhookReconciliationQueueSchema,
} from '../../server/stripe_webhook_reconciliation_queue.mjs';

function subscriptionEvent(overrides = {}) {
  return {
    id: 'evt_subscription',
    type: 'customer.subscription.updated',
    created: 1_787_000_000,
    data: {
      object: {
        id: 'sub_scopeweave',
        object: 'subscription',
      },
    },
    ...overrides,
  };
}

function invoiceEvent(objectOverrides = {}) {
  return {
    id: 'evt_invoice',
    type: 'invoice.paid',
    created: 1_787_000_001,
    data: {
      object: {
        id: 'in_scopeweave',
        object: 'invoice',
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: 'sub_scopeweave' },
        },
        ...objectOverrides,
      },
    },
  };
}

function databaseWithEvent(eventId = 'evt_subscription') {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  installStripeWebhookEventSchema(database);
  installStripeWebhookReconciliationQueueSchema(database);
  database.prepare(`
    INSERT INTO billing_stripe_webhook_events(
      event_id, provider_created_at_sec, event_type, object_id, object_type,
      api_version, request_id, payload_sha256, first_received_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    eventId,
    1_787_000_000,
    'customer.subscription.updated',
    'sub_scopeweave',
    'subscription',
    '2025-03-31.basil',
    null,
    'a'.repeat(64),
    1_787_000_000_000,
  );
  return database;
}

test('subscription webhook candidates use the provider Subscription identity only as a reconciliation trigger', () => {
  assert.equal(
    extractStripeSubscriptionReconciliationCandidate(subscriptionEvent()),
    'sub_scopeweave',
  );
});

test('invoice webhook candidates support current Basil and legacy Subscription provenance', () => {
  assert.equal(
    extractStripeSubscriptionReconciliationCandidate(invoiceEvent()),
    'sub_scopeweave',
  );
  assert.equal(
    extractStripeSubscriptionReconciliationCandidate(invoiceEvent({
      parent: undefined,
      subscription: 'sub_legacy',
    })),
    'sub_legacy',
  );
});

test('invoice webhook candidates fail closed when current and legacy Subscription provenance disagree', () => {
  assert.throws(
    () => extractStripeSubscriptionReconciliationCandidate(invoiceEvent({
      subscription: 'sub_other',
    })),
    (error) => error instanceof StripeWebhookReconciliationQueueError
      && error.code === 'stripe_reconciliation_trigger_invalid',
  );
});

test('non-subscription webhook objects and one-off invoices do not manufacture reconciliation authority', () => {
  assert.equal(
    extractStripeSubscriptionReconciliationCandidate({
      id: 'evt_customer',
      type: 'customer.updated',
      data: { object: { id: 'cus_scopeweave', object: 'customer' } },
    }),
    null,
  );
  assert.equal(
    extractStripeSubscriptionReconciliationCandidate(invoiceEvent({
      parent: null,
      subscription: null,
    })),
    null,
  );
});

test('reconciliation queue persists one normalized pending trigger per verified event', () => {
  const database = databaseWithEvent();
  const queue = createSqliteStripeWebhookReconciliationQueue(database, {
    now: () => 1_787_000_000_123,
  });

  assert.deepEqual(queue.enqueue({
    eventId: 'evt_subscription',
    subscriptionId: 'sub_scopeweave',
  }), {
    eventId: 'evt_subscription',
    subscriptionId: 'sub_scopeweave',
    queued: true,
  });

  assert.deepEqual(database.prepare(`
    SELECT event_id, subscription_id, queued_at_ms, processing_state
      FROM billing_stripe_reconciliation_triggers
  `).get(), {
    event_id: 'evt_subscription',
    subscription_id: 'sub_scopeweave',
    queued_at_ms: 1_787_000_000_123,
    processing_state: 'pending',
  });
});

test('exact webhook redelivery is idempotent but event identity cannot be rebound to another Subscription', () => {
  const database = databaseWithEvent();
  const queue = createSqliteStripeWebhookReconciliationQueue(database, { now: () => 10 });

  queue.enqueue({ eventId: 'evt_subscription', subscriptionId: 'sub_scopeweave' });
  assert.deepEqual(
    queue.enqueue({ eventId: 'evt_subscription', subscriptionId: 'sub_scopeweave' }),
    { eventId: 'evt_subscription', subscriptionId: 'sub_scopeweave', queued: false },
  );
  assert.throws(
    () => queue.enqueue({ eventId: 'evt_subscription', subscriptionId: 'sub_other' }),
    (error) => error instanceof StripeWebhookReconciliationQueueError
      && error.code === 'stripe_reconciliation_trigger_conflict',
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_reconciliation_triggers').get().count,
    1,
  );
});

test('exact redelivery does not depend on a fresh wall-clock read after durable queueing', () => {
  const database = databaseWithEvent();
  let clockReads = 0;
  const queue = createSqliteStripeWebhookReconciliationQueue(database, {
    now: () => {
      clockReads += 1;
      return clockReads === 1 ? 10 : Number.NaN;
    },
  });

  assert.equal(queue.enqueue({
    eventId: 'evt_subscription',
    subscriptionId: 'sub_scopeweave',
  }).queued, true);
  assert.equal(queue.enqueue({
    eventId: 'evt_subscription',
    subscriptionId: 'sub_scopeweave',
  }).queued, false);
  assert.equal(clockReads, 1);
});

test('queue rejects unverified event identities and malformed trigger identifiers', () => {
  const database = databaseWithEvent();
  const queue = createSqliteStripeWebhookReconciliationQueue(database, { now: () => 10 });

  for (const input of [
    { eventId: 'evt_missing', subscriptionId: 'sub_scopeweave' },
    { eventId: '', subscriptionId: 'sub_scopeweave' },
    { eventId: 'evt_subscription', subscriptionId: 'cus_not_subscription' },
  ]) {
    assert.throws(
      () => queue.enqueue(input),
      (error) => error instanceof StripeWebhookReconciliationQueueError,
    );
  }
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_reconciliation_triggers').get().count,
    0,
  );
});
