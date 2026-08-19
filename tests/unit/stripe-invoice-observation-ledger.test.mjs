import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  StripeInvoiceObservationError,
  createSqliteStripeInvoiceObservationRepository,
  installStripeInvoiceObservationSchema,
} from '../../server/stripe_invoice_observation_ledger.mjs';

function databaseWithAuthority() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE orgs(id INTEGER PRIMARY KEY);
    CREATE TABLE billing_stripe_webhook_events(event_id TEXT PRIMARY KEY);
    CREATE TABLE billing_stripe_customers(
      customer_id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES orgs(id),
      first_observed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE billing_stripe_subscriptions(
      subscription_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES billing_stripe_customers(customer_id),
      first_observed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE billing_stripe_subscription_observations(
      observation_id INTEGER PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES billing_stripe_subscriptions(subscription_id),
      latest_invoice_id TEXT
    );
    INSERT INTO orgs(id) VALUES(42),(77);
    INSERT INTO billing_stripe_customers VALUES('cus_42',42,10),('cus_77',77,10);
    INSERT INTO billing_stripe_subscriptions VALUES('sub_42','cus_42',10),('sub_77','cus_77',10);
    INSERT INTO billing_stripe_subscription_observations VALUES(501,'sub_42','in_42'),(777,'sub_77','in_42');
    INSERT INTO billing_stripe_webhook_events VALUES('evt_invoice_paid');
  `);
  installStripeInvoiceObservationSchema(db);
  return db;
}

function paidSnapshot(overrides = {}) {
  return {
    organizationId: 42,
    invoiceId: 'in_42',
    subscriptionId: 'sub_42',
    customerId: 'cus_42',
    status: 'paid',
    paid: true,
    currency: 'krw',
    amountDue: 29000,
    amountPaid: 29000,
    amountRemaining: 0,
    createdSec: 1_786_000_000,
    paidAtSec: 1_786_000_100,
    ...overrides,
  };
}

function expectCode(code, status = 400) {
  return (error) => {
    assert.ok(error instanceof StripeInvoiceObservationError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

test('schema is normalized append-only evidence and contains no entitlement or raw payload columns', () => {
  const db = databaseWithAuthority();
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE 'billing_stripe_invoice%'").all();
  assert.deepEqual(tables.map((row) => row.name).sort(), [
    'billing_stripe_invoice_observations',
    'billing_stripe_invoices',
  ]);
  const sql = tables.map((row) => row.sql).join('\n');
  assert.match(sql, /source_subscription_observation_id/);
  assert.match(sql, /invoice_status/);
  assert.doesNotMatch(sql, /raw|payload|entitlement|orgs\.plan|customer_id\s+TEXT/iu);
  db.close();
});

test('authoritative Invoice snapshot appends with exact Subscription provenance and optional event evidence', () => {
  const db = databaseWithAuthority();
  const repo = createSqliteStripeInvoiceObservationRepository(db, { now: () => 1_000 });
  const result = repo.recordAuthoritativeObservation({
    snapshot: paidSnapshot(),
    sourceSubscriptionObservationId: 501,
    sourceEventId: 'evt_invoice_paid',
  });
  assert.deepEqual(result, {
    observationId: 1,
    invoiceId: 'in_42',
    observedAtMs: 1_000,
    sourceSubscriptionObservationId: 501,
  });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual({...db.prepare('SELECT invoice_id, subscription_id FROM billing_stripe_invoices').get()}, {
    invoice_id: 'in_42',
    subscription_id: 'sub_42',
  });
  assert.deepEqual({...db.prepare(`
    SELECT source_subscription_observation_id, source_event_id, invoice_status,
           paid, currency_code, amount_due_minor, amount_paid_minor,
           amount_remaining_minor, provider_created_at_sec, paid_at_sec
    FROM billing_stripe_invoice_observations
  `).get()}, {
    source_subscription_observation_id: 501,
    source_event_id: 'evt_invoice_paid',
    invoice_status: 'paid',
    paid: 1,
    currency_code: 'krw',
    amount_due_minor: 29000,
    amount_paid_minor: 29000,
    amount_remaining_minor: 0,
    provider_created_at_sec: 1_786_000_000,
    paid_at_sec: 1_786_000_100,
  });
  db.close();
});

test('repeated authoritative reads append and local observation time never moves backwards', () => {
  const db = databaseWithAuthority();
  const clocks = [2_000, 1_500, 1_600];
  const repo = createSqliteStripeInvoiceObservationRepository(db, { now: () => clocks.shift() });
  const first = repo.recordAuthoritativeObservation({ snapshot: paidSnapshot(), sourceSubscriptionObservationId: 501 });
  const second = repo.recordAuthoritativeObservation({ snapshot: paidSnapshot(), sourceSubscriptionObservationId: 501 });
  const third = repo.recordAuthoritativeObservation({
    snapshot: paidSnapshot({ status: 'open', paid: false, paidAtSec: null, amountPaid: 0, amountRemaining: 29000 }),
    sourceSubscriptionObservationId: 501,
  });
  assert.equal(first.observedAtMs, 2_000);
  assert.equal(second.observedAtMs, 2_000);
  assert.equal(third.observedAtMs, 2_000);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_invoices').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_invoice_observations').get().count, 3);
  db.close();
});

test('accepted Subscription observation is mandatory routing authority and all tenant identities must match', () => {
  const db = databaseWithAuthority();
  const repo = createSqliteStripeInvoiceObservationRepository(db, { now: () => 1_000 });
  const cases = [
    [{ snapshot: paidSnapshot(), sourceSubscriptionObservationId: 999 }, 'stripe_invoice_subscription_observation_unknown'],
    [{ snapshot: paidSnapshot({ organizationId: 77 }), sourceSubscriptionObservationId: 501 }, 'stripe_invoice_identity_conflict'],
    [{ snapshot: paidSnapshot({ customerId: 'cus_77' }), sourceSubscriptionObservationId: 501 }, 'stripe_invoice_identity_conflict'],
    [{ snapshot: paidSnapshot({ subscriptionId: 'sub_77' }), sourceSubscriptionObservationId: 501 }, 'stripe_invoice_identity_conflict'],
    [{ snapshot: paidSnapshot({ invoiceId: 'in_other' }), sourceSubscriptionObservationId: 501 }, 'stripe_invoice_identity_conflict'],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => repo.recordAuthoritativeObservation(input), expectCode(code, 409));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_invoices').get().count, 0);
  db.close();
});

test('unknown optional webhook provenance and cross-Subscription Invoice rebinding fail closed', () => {
  const db = databaseWithAuthority();
  const repo = createSqliteStripeInvoiceObservationRepository(db, { now: () => 1_000 });
  assert.throws(() => repo.recordAuthoritativeObservation({
    snapshot: paidSnapshot(), sourceSubscriptionObservationId: 501, sourceEventId: 'evt_unknown',
  }), expectCode('stripe_invoice_source_event_unknown', 409));
  repo.recordAuthoritativeObservation({ snapshot: paidSnapshot(), sourceSubscriptionObservationId: 501 });
  assert.throws(() => repo.recordAuthoritativeObservation({
    snapshot: paidSnapshot({ organizationId: 77, subscriptionId: 'sub_77', customerId: 'cus_77' }),
    sourceSubscriptionObservationId: 777,
  }), expectCode('stripe_invoice_identity_conflict', 409));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_invoices').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_invoice_observations').get().count, 1);
  db.close();
});

test('malformed Invoice facts fail before persistence', () => {
  const db = databaseWithAuthority();
  const repo = createSqliteStripeInvoiceObservationRepository(db, { now: () => 1_000 });
  const badSnapshots = [
    null, [], paidSnapshot({ organizationId: '42' }), paidSnapshot({ invoiceId: '' }),
    paidSnapshot({ subscriptionId: 'sub bad' }), paidSnapshot({ customerId: 'cus bad' }),
    paidSnapshot({ status: 'mystery' }), paidSnapshot({ paid: false }), paidSnapshot({ currency: 'KRW' }),
    paidSnapshot({ amountDue: -1 }), paidSnapshot({ amountPaid: 1.5 }), paidSnapshot({ amountRemaining: -1 }),
    paidSnapshot({ createdSec: -1 }), paidSnapshot({ paidAtSec: null }),
    paidSnapshot({ status: 'open', paid: false, paidAtSec: 1 }),
  ];
  for (const snapshot of badSnapshots) {
    assert.throws(() => repo.recordAuthoritativeObservation({ snapshot, sourceSubscriptionObservationId: 501 }), expectCode('stripe_invoice_observation_invalid'));
  }
  assert.throws(() => repo.recordAuthoritativeObservation({ snapshot: paidSnapshot(), sourceSubscriptionObservationId: 0 }), expectCode('stripe_invoice_observation_invalid'));
  assert.throws(() => repo.recordAuthoritativeObservation({ snapshot: paidSnapshot(), sourceSubscriptionObservationId: 501, sourceEventId: [] }), expectCode('stripe_invoice_observation_invalid'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_invoice_observations').get().count, 0);
  db.close();
});

test('repository dependency and clock contracts fail closed', () => {
  assert.throws(() => createSqliteStripeInvoiceObservationRepository(null), TypeError);
  const db = databaseWithAuthority();
  const defaultRepo = createSqliteStripeInvoiceObservationRepository(db);
  assert.equal(typeof defaultRepo.recordAuthoritativeObservation, 'function');
  assert.throws(() => createSqliteStripeInvoiceObservationRepository(db, { now: null }), TypeError);
  const repo = createSqliteStripeInvoiceObservationRepository(db, { now: () => -1 });
  assert.throws(() => repo.recordAuthoritativeObservation({ snapshot: paidSnapshot(), sourceSubscriptionObservationId: 501 }), expectCode('stripe_invoice_observation_invalid'));
  db.close();
});

test('savepoint cleanup preserves the causal write error and never releases unconfirmed failed state', () => {
  const inner = databaseWithAuthority();
  const commands = [];
  let failRollback = false;
  let failCleanupRelease = false;
  const wrapped = {
    prepare(sql) {
      const statement = inner.prepare(sql);
      if (sql.includes('INSERT INTO billing_stripe_invoice_observations(')) {
        return { run() { throw new Error('causal invoice observation write failure'); } };
      }
      return statement;
    },
    exec(sql) {
      commands.push(sql);
      if (sql.startsWith('ROLLBACK TO') && failRollback) throw new Error('rollback failed');
      if (sql.startsWith('RELEASE') && failCleanupRelease) throw new Error('cleanup release failed');
      return inner.exec(sql);
    },
  };

  let repo = createSqliteStripeInvoiceObservationRepository(wrapped, { now: () => 1_000 });
  failCleanupRelease = true;
  assert.throws(() => repo.recordAuthoritativeObservation({ snapshot: paidSnapshot(), sourceSubscriptionObservationId: 501 }), /causal invoice observation write failure/);
  assert.ok(commands.some((sql) => sql.startsWith('ROLLBACK TO')));
  assert.ok(commands.some((sql) => sql.startsWith('RELEASE')));

  inner.exec('ROLLBACK');
  commands.length = 0;
  failCleanupRelease = false;
  failRollback = true;
  repo = createSqliteStripeInvoiceObservationRepository(wrapped, { now: () => 1_000 });
  assert.throws(() => repo.recordAuthoritativeObservation({ snapshot: paidSnapshot(), sourceSubscriptionObservationId: 501 }), /causal invoice observation write failure/);
  assert.ok(commands.some((sql) => sql.startsWith('ROLLBACK TO')));
  assert.equal(commands.filter((sql) => sql.startsWith('RELEASE')).length, 0);
  inner.close();
});
