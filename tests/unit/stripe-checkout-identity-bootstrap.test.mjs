import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { installBillingCheckoutAttemptSchema } from '../../server/billing_checkout_attempt.mjs';
import { installStripeWebhookEventSchema } from '../../server/stripe_webhook_event_ledger.mjs';
import { installStripeSubscriptionObservationSchema } from '../../server/stripe_subscription_observation_ledger.mjs';
import {
  StripeCheckoutIdentityBootstrapError,
  bindVerifiedStripeCheckoutSessionIdentity,
} from '../../server/stripe_checkout_identity_bootstrap.mjs';

const RECEIVED_AT_MS = 1_787_100_000_123;

function bootstrapDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      token_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE orgs (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      plan TEXT NOT NULL DEFAULT 'free'
    );
    INSERT INTO users(id, email, password_hash, name) VALUES
      (1, 'owner-one@example.invalid', 'hash', 'Owner One'),
      (2, 'owner-two@example.invalid', 'hash', 'Owner Two');
    INSERT INTO orgs(id, name, owner_id, plan) VALUES
      (1, 'Org One', 1, 'free'),
      (2, 'Org Two', 2, 'free');
  `);
  installBillingCheckoutAttemptSchema(database);
  installStripeWebhookEventSchema(database);
  installStripeSubscriptionObservationSchema(database);
  return database;
}

function insertSucceededAttempt(database, {
  attemptId = 'attempt_one',
  organizationId = 1,
  sessionId = 'cs_scopeweave',
  priceId = 'price_scopeweave',
} = {}) {
  database.prepare(`
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
    RECEIVED_AT_MS - 10,
    RECEIVED_AT_MS - 5,
  );
}

function insertVerifiedEvent(database, {
  eventId = 'evt_checkout_completed',
  sessionId = 'cs_scopeweave',
  eventType = 'checkout.session.completed',
  objectType = 'checkout.session',
} = {}) {
  database.prepare(`
    INSERT INTO billing_stripe_webhook_events(
      event_id, provider_created_at_sec, event_type, object_id, object_type,
      api_version, request_id, payload_sha256, first_received_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    eventId,
    1_787_100_000,
    eventType,
    sessionId,
    objectType,
    '2025-03-31.basil',
    null,
    'a'.repeat(64),
    RECEIVED_AT_MS,
  );
}

function checkoutEvent({
  eventId = 'evt_checkout_completed',
  sessionId = 'cs_scopeweave',
  customerId = 'cus_scopeweave',
  subscriptionId = 'sub_scopeweave',
  type = 'checkout.session.completed',
} = {}) {
  return {
    id: eventId,
    object: 'event',
    type,
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

test('verified Checkout completion permanently bootstraps Customer and Subscription tenant identity from the local successful attempt', () => {
  const database = bootstrapDatabase();
  insertSucceededAttempt(database);
  insertVerifiedEvent(database);

  assert.deepEqual(
    bindVerifiedStripeCheckoutSessionIdentity(database, checkoutEvent()),
    {
      eventId: 'evt_checkout_completed',
      organizationId: 1,
      customerId: 'cus_scopeweave',
      subscriptionId: 'sub_scopeweave',
      bound: true,
    },
  );

  assert.deepEqual({ ...database.prepare(`
    SELECT customer_id, organization_id, first_observed_at_ms
      FROM billing_stripe_customers
  `).get() }, {
    customer_id: 'cus_scopeweave',
    organization_id: 1,
    first_observed_at_ms: RECEIVED_AT_MS,
  });
  assert.deepEqual({ ...database.prepare(`
    SELECT subscription_id, customer_id, first_observed_at_ms
      FROM billing_stripe_subscriptions
  `).get() }, {
    subscription_id: 'sub_scopeweave',
    customer_id: 'cus_scopeweave',
    first_observed_at_ms: RECEIVED_AT_MS,
  });
  assert.equal(database.prepare('SELECT plan FROM orgs WHERE id = 1').get().plan, 'free');
});

test('exact verified Checkout completion replay is idempotent and does not rewrite first-observed evidence', () => {
  const database = bootstrapDatabase();
  insertSucceededAttempt(database);
  insertVerifiedEvent(database);

  assert.equal(bindVerifiedStripeCheckoutSessionIdentity(database, checkoutEvent()).bound, true);
  assert.deepEqual(bindVerifiedStripeCheckoutSessionIdentity(database, checkoutEvent()), {
    eventId: 'evt_checkout_completed',
    organizationId: 1,
    customerId: 'cus_scopeweave',
    subscriptionId: 'sub_scopeweave',
    bound: false,
  });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_customers').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_subscriptions').get().count, 1);
  assert.equal(
    database.prepare('SELECT first_observed_at_ms FROM billing_stripe_customers').get().first_observed_at_ms,
    RECEIVED_AT_MS,
  );
});

test('bootstrap fails closed unless the verified event and successful local Checkout attempt agree on exact session identity', () => {
  const database = bootstrapDatabase();
  insertSucceededAttempt(database);
  insertVerifiedEvent(database);

  for (const event of [
    checkoutEvent({ sessionId: 'cs_other' }),
    checkoutEvent({ eventId: 'evt_missing' }),
    checkoutEvent({ type: 'invoice.paid' }),
  ]) {
    assert.throws(
      () => bindVerifiedStripeCheckoutSessionIdentity(database, event),
      (error) => error instanceof StripeCheckoutIdentityBootstrapError,
    );
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_customers').get().count, 0);
});

test('ambiguous local session ownership and cross-tenant provider identity rebinding are rejected', () => {
  const ambiguous = bootstrapDatabase();
  insertSucceededAttempt(ambiguous);
  insertSucceededAttempt(ambiguous, {
    attemptId: 'attempt_two',
    organizationId: 2,
    sessionId: 'cs_scopeweave',
    priceId: 'price_other',
  });
  insertVerifiedEvent(ambiguous);
  assert.throws(
    () => bindVerifiedStripeCheckoutSessionIdentity(ambiguous, checkoutEvent()),
    (error) => error instanceof StripeCheckoutIdentityBootstrapError
      && error.code === 'stripe_checkout_identity_ambiguous',
  );

  const rebound = bootstrapDatabase();
  insertSucceededAttempt(rebound);
  insertVerifiedEvent(rebound);
  bindVerifiedStripeCheckoutSessionIdentity(rebound, checkoutEvent());
  insertSucceededAttempt(rebound, {
    attemptId: 'attempt_two',
    organizationId: 2,
    sessionId: 'cs_other',
    priceId: 'price_other',
  });
  insertVerifiedEvent(rebound, {
    eventId: 'evt_checkout_other',
    sessionId: 'cs_other',
  });
  assert.throws(
    () => bindVerifiedStripeCheckoutSessionIdentity(rebound, checkoutEvent({
      eventId: 'evt_checkout_other',
      sessionId: 'cs_other',
    })),
    (error) => error instanceof StripeCheckoutIdentityBootstrapError
      && error.code === 'stripe_checkout_identity_conflict',
  );
  assert.equal(databaseCount(rebound, 'billing_stripe_customers'), 1);
  assert.equal(databaseCount(rebound, 'billing_stripe_subscriptions'), 1);
});

function databaseCount(database, table) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

test('expanded or malformed provider identities fail closed before persistence', () => {
  const database = bootstrapDatabase();
  insertSucceededAttempt(database);
  insertVerifiedEvent(database);

  const malformed = [
    checkoutEvent({ customerId: { id: 'cus_scopeweave' } }),
    checkoutEvent({ subscriptionId: { id: 'sub_scopeweave' } }),
    { ...checkoutEvent(), data: { object: { ...checkoutEvent().data.object, mode: 'payment' } } },
  ];
  for (const event of malformed) {
    assert.throws(
      () => bindVerifiedStripeCheckoutSessionIdentity(database, event),
      (error) => error instanceof StripeCheckoutIdentityBootstrapError
        && error.code === 'stripe_checkout_identity_invalid',
    );
  }
  assert.equal(databaseCount(database, 'billing_stripe_customers'), 0);
});

test('Customer and Subscription bootstrap roll back together when the second identity write fails', () => {
  const database = bootstrapDatabase();
  insertSucceededAttempt(database);
  insertVerifiedEvent(database);
  database.exec(`
    CREATE TEMP TRIGGER force_subscription_identity_failure
    BEFORE INSERT ON billing_stripe_subscriptions
    BEGIN
      SELECT RAISE(ABORT, 'forced identity failure');
    END;
  `);

  assert.throws(() => bindVerifiedStripeCheckoutSessionIdentity(database, checkoutEvent()));
  assert.equal(databaseCount(database, 'billing_stripe_customers'), 0);
  assert.equal(databaseCount(database, 'billing_stripe_subscriptions'), 0);
});
