import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  StripeSubscriptionObservationError,
  createSqliteStripeSubscriptionObservationRepository,
  installStripeSubscriptionObservationSchema,
} from '../../server/stripe_subscription_observation_ledger.mjs';

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
    INSERT INTO billing_stripe_webhook_events(event_id)
      VALUES('evt_subscription_reconcile_1');
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

function setup(now = () => 1_787_000_100_000) {
  const database = createDatabase();
  const repository = createSqliteStripeSubscriptionObservationRepository(database, { now });
  return { database, repository };
}

function tableColumns(database, tableName) {
  return database.prepare(`PRAGMA table_info('${tableName}')`).all().map((row) => row.name);
}

test('bootstrap schema keeps customer, subscription, observation, and price facts in normalized relations', () => {
  const database = createDatabase();
  installStripeSubscriptionObservationSchema(database);

  assert.deepEqual(tableColumns(database, 'billing_stripe_customers'), [
    'customer_id', 'organization_id', 'first_observed_at_ms',
  ]);
  assert.deepEqual(tableColumns(database, 'billing_stripe_subscriptions'), [
    'subscription_id', 'customer_id', 'first_observed_at_ms',
  ]);
  assert.deepEqual(tableColumns(database, 'billing_stripe_prices'), [
    'price_id', 'first_observed_at_ms',
  ]);
  assert.deepEqual(tableColumns(database, 'billing_stripe_subscription_observations'), [
    'observation_id', 'subscription_id', 'source_event_id', 'observed_at_ms',
    'subscription_status', 'cancel_at_period_end', 'current_period_start_sec',
    'current_period_end_sec', 'canceled_at_sec', 'ended_at_sec', 'trial_end_sec',
    'latest_invoice_id',
  ]);
  assert.deepEqual(tableColumns(database, 'billing_stripe_subscription_observation_prices'), [
    'observation_id', 'position_index', 'price_id',
  ]);

  const ownedTables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'billing_stripe_%'
    ORDER BY name
  `).all().map((row) => row.name);
  for (const name of ownedTables.filter((name) => name !== 'billing_stripe_webhook_events')) {
    assert.match(name, /^[a-z]+_[a-z0-9]+(?:_[a-z0-9]+)+$/);
  }
});

test('one authoritative snapshot records tenant-bound identity and an immutable observation without changing entitlement', () => {
  const { database, repository } = setup();
  const result = repository.recordAuthoritativeObservation({
    snapshot: snapshot(),
    sourceEventId: 'evt_subscription_reconcile_1',
  });

  assert.deepEqual(result, {
    observationId: 1,
    subscriptionId: 'sub_scopeweave_42',
    observedAtMs: 1_787_000_100_000,
  });
  assert.deepEqual({ ...database.prepare('SELECT * FROM billing_stripe_customers').get() }, {
    customer_id: 'cus_scopeweave_42',
    organization_id: 42,
    first_observed_at_ms: 1_787_000_100_000,
  });
  assert.deepEqual({ ...database.prepare('SELECT * FROM billing_stripe_subscriptions').get() }, {
    subscription_id: 'sub_scopeweave_42',
    customer_id: 'cus_scopeweave_42',
    first_observed_at_ms: 1_787_000_100_000,
  });
  assert.deepEqual({ ...database.prepare('SELECT * FROM billing_stripe_subscription_observations').get() }, {
    observation_id: 1,
    subscription_id: 'sub_scopeweave_42',
    source_event_id: 'evt_subscription_reconcile_1',
    observed_at_ms: 1_787_000_100_000,
    subscription_status: 'active',
    cancel_at_period_end: 0,
    current_period_start_sec: 1_787_000_000,
    current_period_end_sec: 1_789_678_400,
    canceled_at_sec: null,
    ended_at_sec: null,
    trial_end_sec: null,
    latest_invoice_id: 'in_scopeweave_42',
  });
  assert.deepEqual(
    database.prepare(`
      SELECT position_index, price_id
      FROM billing_stripe_subscription_observation_prices
      ORDER BY position_index
    `).all().map((row) => ({ ...row })),
    [
      { position_index: 0, price_id: 'price_scopeweave_pro' },
      { position_index: 1, price_id: 'price_scopeweave_storage' },
    ],
  );
  assert.equal(database.prepare('SELECT plan FROM orgs WHERE id = 42').get().plan, 'free');
});

test('repeat authoritative reads append evidence while reusing normalized provider identities', () => {
  let clock = 1_787_000_100_000;
  const { database, repository } = setup(() => clock);
  repository.recordAuthoritativeObservation({ snapshot: snapshot() });
  clock += 25;
  repository.recordAuthoritativeObservation({
    snapshot: snapshot({ status: 'past_due', cancelAtPeriodEnd: true }),
  });

  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_customers').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_subscriptions').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_prices').get().count, 2);
  assert.deepEqual(
    database.prepare(`
      SELECT observed_at_ms, subscription_status, cancel_at_period_end
      FROM billing_stripe_subscription_observations
      ORDER BY observation_id
    `).all().map((row) => ({ ...row })),
    [
      { observed_at_ms: 1_787_000_100_000, subscription_status: 'active', cancel_at_period_end: 0 },
      { observed_at_ms: 1_787_000_100_025, subscription_status: 'past_due', cancel_at_period_end: 1 },
    ],
  );
});

test('provider customer and subscription identifiers can never be rebound across tenants or customers', () => {
  const { database, repository } = setup();
  repository.recordAuthoritativeObservation({ snapshot: snapshot() });

  assert.throws(
    () => repository.recordAuthoritativeObservation({
      snapshot: snapshot({ organizationId: 84 }),
    }),
    (error) => error instanceof StripeSubscriptionObservationError
      && error.code === 'stripe_subscription_identity_conflict',
  );
  assert.throws(
    () => repository.recordAuthoritativeObservation({
      snapshot: snapshot({ customerId: 'cus_scopeweave_other' }),
    }),
    (error) => error instanceof StripeSubscriptionObservationError
      && error.code === 'stripe_subscription_identity_conflict',
  );

  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_subscription_observations').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_customers').get().count, 1);
});

test('invalid snapshots and unknown source-event evidence fail before durable state changes', () => {
  const invalidSnapshots = [
    snapshot({ organizationId: 0 }),
    snapshot({ organizationId: 1.5 }),
    snapshot({ subscriptionId: '' }),
    snapshot({ customerId: {} }),
    snapshot({ status: 'mystery' }),
    snapshot({ cancelAtPeriodEnd: 'false' }),
    snapshot({ currentPeriodStartSec: -1 }),
    snapshot({ currentPeriodEndSec: 1_786_999_999 }),
    snapshot({ priceIds: [] }),
    snapshot({ priceIds: [''] }),
    snapshot({ latestInvoiceId: {} }),
  ];

  for (const candidate of invalidSnapshots) {
    const { database, repository } = setup();
    assert.throws(
      () => repository.recordAuthoritativeObservation({ snapshot: candidate }),
      (error) => error instanceof StripeSubscriptionObservationError
        && error.code === 'stripe_subscription_observation_invalid',
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_subscription_observations').get().count, 0);
  }

  const { database, repository } = setup();
  assert.throws(
    () => repository.recordAuthoritativeObservation({
      snapshot: snapshot(),
      sourceEventId: 'evt_not_persisted',
    }),
    (error) => error instanceof StripeSubscriptionObservationError
      && error.code === 'stripe_subscription_source_event_unknown',
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_customers').get().count, 0);
});

test('a downstream observation-price write failure rolls back every identity and observation mutation', () => {
  const { database, repository } = setup();
  database.exec(`
    CREATE TRIGGER billing_stripe_test_price_failure
    BEFORE INSERT ON billing_stripe_subscription_observation_prices
    WHEN NEW.position_index = 1
    BEGIN
      SELECT RAISE(ABORT, 'simulated downstream persistence failure');
    END;
  `);

  assert.throws(
    () => repository.recordAuthoritativeObservation({ snapshot: snapshot() }),
    /simulated downstream persistence failure/,
  );

  for (const table of [
    'billing_stripe_customers',
    'billing_stripe_subscriptions',
    'billing_stripe_prices',
    'billing_stripe_subscription_observations',
    'billing_stripe_subscription_observation_prices',
  ]) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  }
  assert.equal(database.prepare('SELECT plan FROM orgs WHERE id = 42').get().plan, 'free');
});

test('savepoint rollback cleanup preserves the causal write failure and never releases unconfirmed state', () => {
  const database = createDatabase();
  database.exec(`
    CREATE TRIGGER billing_stripe_test_price_failure
    BEFORE INSERT ON billing_stripe_subscription_observation_prices
    WHEN NEW.position_index = 1
    BEGIN
      SELECT RAISE(ABORT, 'causal observation write failure');
    END;
  `);

  const executed = [];
  const guardedDatabase = {
    prepare: database.prepare.bind(database),
    exec(sql) {
      executed.push(sql);
      if (sql === 'ROLLBACK TO SAVEPOINT billing_stripe_subscription_observation_write') {
        throw new Error('simulated rollback cleanup failure');
      }
      return database.exec(sql);
    },
  };
  const repository = createSqliteStripeSubscriptionObservationRepository(guardedDatabase);

  assert.throws(
    () => repository.recordAuthoritativeObservation({ snapshot: snapshot() }),
    /causal observation write failure/,
  );
  assert.equal(
    executed.filter((sql) => sql === 'RELEASE SAVEPOINT billing_stripe_subscription_observation_write').length,
    0,
    'failed rollback must not release an unconfirmed savepoint and accidentally commit partial state',
  );
});

test('observation timestamps are monotonic per subscription despite local clock rollback', () => {
  const times = [1_787_000_100_000, 1_787_000_099_000];
  const { database, repository } = setup(() => times.shift());
  repository.recordAuthoritativeObservation({ snapshot: snapshot() });
  const result = repository.recordAuthoritativeObservation({
    snapshot: snapshot({ status: 'past_due' }),
  });

  assert.equal(result.observedAtMs, 1_787_000_100_000);
  assert.deepEqual(
    database.prepare(`
      SELECT observed_at_ms FROM billing_stripe_subscription_observations
      ORDER BY observation_id
    `).all().map((row) => row.observed_at_ms),
    [1_787_000_100_000, 1_787_000_100_000],
  );
});
