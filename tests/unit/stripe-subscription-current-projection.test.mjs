import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createSqliteStripeSubscriptionObservationRepository,
  installStripeSubscriptionObservationSchema,
} from '../../server/stripe_subscription_observation_ledger.mjs';
import {
  createSqliteStripeSubscriptionCurrentProjection,
} from '../../server/stripe_subscription_current_projection.mjs';

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE orgs (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      plan TEXT NOT NULL DEFAULT 'free'
    );
    CREATE TABLE billing_stripe_webhook_events (
      event_id TEXT PRIMARY KEY
    );
    INSERT INTO users(id, email, password_hash, name)
      VALUES(1, 'owner@example.test', 'hash', 'Owner');
    INSERT INTO orgs(id, name, owner_id, plan)
      VALUES(42, 'Acquisition-grade buyer', 1, 'free'),
            (84, 'Other tenant', 1, 'free');
  `);
  installStripeSubscriptionObservationSchema(database);
  return database;
}

function snapshot(overrides = {}) {
  return Object.freeze({
    subscriptionId: 'sub_scopeweave_42',
    customerId: 'cus_scopeweave_42',
    organizationId: 42,
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodStartSec: 1_787_000_000,
    currentPeriodEndSec: 1_789_678_400,
    canceledAtSec: null,
    endedAtSec: null,
    trialEndSec: null,
    latestInvoiceId: 'in_scopeweave_42',
    priceIds: Object.freeze(['price_scopeweave_pro', 'price_scopeweave_storage']),
    ...overrides,
  });
}

function setup(times = [1_787_000_100_000]) {
  const database = createDatabase();
  let clockIndex = 0;
  const observationRepository = createSqliteStripeSubscriptionObservationRepository(database, {
    now: () => times[Math.min(clockIndex++, times.length - 1)],
  });
  const projection = createSqliteStripeSubscriptionCurrentProjection(database);
  return { database, observationRepository, projection };
}

test('current projection returns the newest accepted authoritative read with ordered provenance', () => {
  const { database, observationRepository, projection } = setup([
    1_787_000_100_000,
    1_787_000_100_000,
  ]);
  observationRepository.recordAuthoritativeObservation({ snapshot: snapshot() });
  const second = observationRepository.recordAuthoritativeObservation({
    snapshot: snapshot({
      status: 'past_due',
      cancelAtPeriodEnd: true,
      currentPeriodStartSec: 1_789_678_400,
      currentPeriodEndSec: 1_792_357_200,
      latestInvoiceId: 'in_scopeweave_42_retry',
      priceIds: Object.freeze(['price_scopeweave_storage', 'price_scopeweave_pro']),
    }),
  });

  const beforeObservationCount = database.prepare(
    'SELECT COUNT(*) AS count FROM billing_stripe_subscription_observations',
  ).get().count;
  const current = projection.getCurrentSubscription({
    organizationId: 42,
    subscriptionId: 'sub_scopeweave_42',
  });

  assert.deepEqual(current, {
    observationId: second.observationId,
    observedAtMs: 1_787_000_100_000,
    organizationId: 42,
    customerId: 'cus_scopeweave_42',
    subscriptionId: 'sub_scopeweave_42',
    status: 'past_due',
    cancelAtPeriodEnd: true,
    currentPeriodStartSec: 1_789_678_400,
    currentPeriodEndSec: 1_792_357_200,
    canceledAtSec: null,
    endedAtSec: null,
    trialEndSec: null,
    latestInvoiceId: 'in_scopeweave_42_retry',
    sourceEventId: null,
    priceIds: ['price_scopeweave_storage', 'price_scopeweave_pro'],
  });
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.priceIds), true);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_subscription_observations').get().count,
    beforeObservationCount,
    'read projection must not mutate authoritative evidence',
  );
  assert.equal(database.prepare('SELECT plan FROM orgs WHERE id = 42').get().plan, 'free');
});

test('projection is tenant-scoped and never reveals another organization subscription', () => {
  const { observationRepository, projection } = setup();
  observationRepository.recordAuthoritativeObservation({ snapshot: snapshot() });

  assert.equal(projection.getCurrentSubscription({
    organizationId: 84,
    subscriptionId: 'sub_scopeweave_42',
  }), null);
  assert.deepEqual(projection.listCurrentSubscriptions({ organizationId: 84 }), []);
});

test('organization projection returns one newest row per subscription in stable identifier order', () => {
  const { observationRepository, projection } = setup([
    1_787_000_100_000,
    1_787_000_100_010,
    1_787_000_100_020,
  ]);
  observationRepository.recordAuthoritativeObservation({
    snapshot: snapshot({
      subscriptionId: 'sub_scopeweave_zeta',
      customerId: 'cus_scopeweave_zeta',
      priceIds: Object.freeze(['price_zeta']),
    }),
  });
  observationRepository.recordAuthoritativeObservation({
    snapshot: snapshot({
      subscriptionId: 'sub_scopeweave_alpha',
      customerId: 'cus_scopeweave_alpha',
      status: 'trialing',
      latestInvoiceId: null,
      priceIds: Object.freeze(['price_alpha']),
    }),
  });
  observationRepository.recordAuthoritativeObservation({
    snapshot: snapshot({
      subscriptionId: 'sub_scopeweave_zeta',
      customerId: 'cus_scopeweave_zeta',
      status: 'canceled',
      cancelAtPeriodEnd: false,
      canceledAtSec: 1_787_000_050,
      endedAtSec: 1_787_000_060,
      priceIds: Object.freeze(['price_zeta_replacement']),
    }),
  });

  const subscriptions = projection.listCurrentSubscriptions({ organizationId: 42 });
  assert.equal(subscriptions.length, 2);
  assert.deepEqual(subscriptions.map((entry) => [entry.subscriptionId, entry.status, entry.priceIds]), [
    ['sub_scopeweave_alpha', 'trialing', ['price_alpha']],
    ['sub_scopeweave_zeta', 'canceled', ['price_zeta_replacement']],
  ]);
  assert.equal(Object.isFrozen(subscriptions), true);
  assert.equal(subscriptions.every(Object.isFrozen), true);
});

test('projection returns null or an empty list when no accepted observation exists', () => {
  const { projection } = setup();
  assert.equal(projection.getCurrentSubscription({
    organizationId: 42,
    subscriptionId: 'sub_scopeweave_absent',
  }), null);
  assert.deepEqual(projection.listCurrentSubscriptions({ organizationId: 42 }), []);
});

test('projection rejects malformed local authority before querying', () => {
  const { projection } = setup();
  for (const organizationId of [0, -1, 1.5, Number.NaN, {}, '']) {
    assert.throws(
      () => projection.listCurrentSubscriptions({ organizationId }),
      TypeError,
    );
  }
  for (const subscriptionId of ['', ' ', {}, [], 'x'.repeat(256)]) {
    assert.throws(
      () => projection.getCurrentSubscription({ organizationId: 42, subscriptionId }),
      TypeError,
    );
  }
});
