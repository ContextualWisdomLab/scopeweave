import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createSqliteStripeInvoiceCurrentProjection } from '../../server/stripe_invoice_current_projection.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE billing_stripe_customers(
      customer_id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL
    );
    CREATE TABLE billing_stripe_subscriptions(
      subscription_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL
    );
    CREATE TABLE billing_stripe_invoices(
      invoice_id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL
    );
    CREATE TABLE billing_stripe_invoice_observations(
      observation_id INTEGER PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      source_subscription_observation_id INTEGER NOT NULL,
      source_event_id TEXT,
      observed_at_ms INTEGER NOT NULL,
      invoice_status TEXT NOT NULL,
      paid INTEGER NOT NULL,
      currency_code TEXT NOT NULL,
      amount_due_minor INTEGER NOT NULL,
      amount_paid_minor INTEGER NOT NULL,
      amount_remaining_minor INTEGER NOT NULL,
      provider_created_at_sec INTEGER NOT NULL,
      paid_at_sec INTEGER
    );
    INSERT INTO billing_stripe_customers VALUES('cus_42',42),('cus_77',77);
    INSERT INTO billing_stripe_subscriptions VALUES('sub_a','cus_42'),('sub_b','cus_42'),('sub_other','cus_77');
    INSERT INTO billing_stripe_invoices VALUES('in_a','sub_a'),('in_b','sub_b'),('in_other','sub_other');
    INSERT INTO billing_stripe_invoice_observations VALUES
      (1,'in_a',101,'evt_old',9000,'open',0,'krw',29000,0,29000,5000,NULL),
      (2,'in_a',102,'evt_paid',1000,'paid',1,'krw',29000,29000,0,4000,4100),
      (3,'in_b',201,NULL,8000,'paid',1,'usd',1200,1200,0,6000,6100),
      (4,'in_other',301,'evt_other',9000,'paid',1,'krw',5000,5000,0,7000,7100);
  `);
  return db;
}

test('getCurrentInvoice selects append order, preserves provenance, and returns immutable normalized evidence', () => {
  const db = fixture();
  const projection = createSqliteStripeInvoiceCurrentProjection(db);
  assert.ok(Object.isFrozen(projection));
  const current = projection.getCurrentInvoice({ organizationId: 42, invoiceId: 'in_a' });
  assert.deepEqual(current, {
    observationId: 2,
    observedAtMs: 1000,
    organizationId: 42,
    customerId: 'cus_42',
    subscriptionId: 'sub_a',
    invoiceId: 'in_a',
    sourceSubscriptionObservationId: 102,
    sourceEventId: 'evt_paid',
    status: 'paid',
    paid: true,
    currency: 'krw',
    amountDue: 29000,
    amountPaid: 29000,
    amountRemaining: 0,
    createdSec: 4000,
    paidAtSec: 4100,
  });
  assert.ok(Object.isFrozen(current));
  db.close();
});

test('tenant isolation returns null for foreign or absent Invoice identities', () => {
  const db = fixture();
  const projection = createSqliteStripeInvoiceCurrentProjection(db);
  assert.equal(projection.getCurrentInvoice({ organizationId: 42, invoiceId: 'in_other' }), null);
  assert.equal(projection.getCurrentInvoice({ organizationId: 77, invoiceId: 'in_a' }), null);
  assert.equal(projection.getCurrentInvoice({ organizationId: 42, invoiceId: 'in_missing' }), null);
  db.close();
});

test('listCurrentInvoices returns exactly one latest Invoice per tenant and can narrow to one Subscription', () => {
  const db = fixture();
  const projection = createSqliteStripeInvoiceCurrentProjection(db);
  const all = projection.listCurrentInvoices({ organizationId: '42' });
  assert.ok(Object.isFrozen(all));
  assert.deepEqual(all.map((row) => [row.invoiceId, row.observationId, row.paidAtSec]), [
    ['in_a', 2, 4100],
    ['in_b', 3, 6100],
  ]);
  assert.ok(all.every(Object.isFrozen));
  assert.deepEqual(
    projection.listCurrentInvoices({ organizationId: 42, subscriptionId: 'sub_a' }).map((row) => row.invoiceId),
    ['in_a'],
  );
  assert.deepEqual(projection.listCurrentInvoices({ organizationId: 42, subscriptionId: 'sub_other' }), []);
  db.close();
});

test('unpaid projection preserves null paid time and false paid flag', () => {
  const db = fixture();
  db.exec(`INSERT INTO billing_stripe_invoice_observations VALUES
    (5,'in_b',202,NULL,9000,'void',0,'usd',1200,0,1200,8000,NULL)`);
  const current = createSqliteStripeInvoiceCurrentProjection(db)
    .getCurrentInvoice({ organizationId: 42, invoiceId: 'in_b' });
  assert.equal(current.status, 'void');
  assert.equal(current.paid, false);
  assert.equal(current.paidAtSec, null);
  assert.equal(current.sourceEventId, null);
  db.close();
});

test('canonical tenant and provider authority validation rejects ambiguous input before SQL use', () => {
  const db = fixture();
  const projection = createSqliteStripeInvoiceCurrentProjection(db);
  for (const organizationId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, null, '0', '042', '+42', '4e1', ' 42 ']) {
    assert.throws(() => projection.getCurrentInvoice({ organizationId, invoiceId: 'in_a' }), TypeError);
  }
  for (const invoiceId of ['', 'in bad', [], null, 'x'.repeat(256)]) {
    assert.throws(() => projection.getCurrentInvoice({ organizationId: 42, invoiceId }), TypeError);
  }
  for (const subscriptionId of ['', 'sub bad', [], 'x'.repeat(256)]) {
    assert.throws(() => projection.listCurrentInvoices({ organizationId: 42, subscriptionId }), TypeError);
  }
  db.close();
});

test('projection dependency contract rejects unusable databases', () => {
  assert.throws(() => createSqliteStripeInvoiceCurrentProjection(null), TypeError);
  assert.throws(() => createSqliteStripeInvoiceCurrentProjection({}), TypeError);
});
