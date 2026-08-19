import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  PLANS,
  configureBillingEntitlementDatabase,
  effectivePlanOf,
  planOf,
  wouldExceed,
} from '../../server/billing.mjs';

function database({ withClaims = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL);
    CREATE TABLE memberships(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL);
    INSERT INTO projects(org_id) VALUES(42),(42);
    INSERT INTO memberships(org_id) VALUES(42),(42),(42);
  `);
  if (withClaims) {
    db.exec(`
      CREATE TABLE billing_stripe_customers(customer_id TEXT PRIMARY KEY, organization_id INTEGER NOT NULL);
      CREATE TABLE billing_stripe_subscriptions(subscription_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL);
      CREATE TABLE billing_stripe_entitlement_decisions(
        decision_id INTEGER PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        entitled INTEGER NOT NULL,
        valid_until_sec INTEGER
      );
      CREATE TABLE billing_stripe_entitlement_claim_heads(
        subscription_id TEXT PRIMARY KEY,
        decision_id INTEGER NOT NULL
      );
      INSERT INTO billing_stripe_customers VALUES('cus_42',42),('cus_77',77);
      INSERT INTO billing_stripe_subscriptions VALUES('sub_42','cus_42'),('sub_other','cus_77');
    `);
  }
  return db;
}

function freeOrg() { return { id: 42, plan: 'free' }; }

test('free limits remain enforced when there is no current Stripe claim', () => {
  const db = database();
  assert.equal(effectivePlanOf(db, freeOrg(), { nowSec: 1000 }), PLANS.free);
  assert.equal(wouldExceed(db, freeOrg(), 'projects', { nowSec: 1000 }), true);
  assert.equal(wouldExceed(db, freeOrg(), 'members', { nowSec: 1000 }), true);
  db.close();
});

test('one unexpired current entitled claim reversibly unlocks Pro resource limits', () => {
  const db = database();
  db.exec(`
    INSERT INTO billing_stripe_entitlement_decisions VALUES(1,'sub_42',1,2000);
    INSERT INTO billing_stripe_entitlement_claim_heads VALUES('sub_42',1);
  `);
  assert.equal(effectivePlanOf(db, freeOrg(), { nowSec: 1000 }), PLANS.pro);
  assert.equal(wouldExceed(db, freeOrg(), 'projects', { nowSec: 1000 }), false);
  assert.equal(wouldExceed(db, freeOrg(), 'members', { nowSec: 1000 }), false);
  db.close();
});

test('claim expiry and a later revoke head re-lock Pro limits without mutating org.plan', () => {
  const db = database();
  db.exec(`
    INSERT INTO billing_stripe_entitlement_decisions VALUES(1,'sub_42',1,2000);
    INSERT INTO billing_stripe_entitlement_claim_heads VALUES('sub_42',1);
  `);
  assert.equal(effectivePlanOf(db, freeOrg(), { nowSec: 2000 }), PLANS.free);
  assert.equal(wouldExceed(db, freeOrg(), 'projects', { nowSec: 2000 }), true);
  db.exec(`
    INSERT INTO billing_stripe_entitlement_decisions VALUES(2,'sub_42',0,NULL);
    UPDATE billing_stripe_entitlement_claim_heads SET decision_id=2 WHERE subscription_id='sub_42';
  `);
  assert.equal(effectivePlanOf(db, freeOrg(), { nowSec: 1500 }), PLANS.free);
  assert.equal(freeOrg().plan, 'free');
  db.close();
});

test('foreign-tenant claims never unlock this organization and one valid local claim among many is sufficient', () => {
  const db = database();
  db.exec(`
    INSERT INTO billing_stripe_entitlement_decisions VALUES(1,'sub_other',1,5000);
    INSERT INTO billing_stripe_entitlement_claim_heads VALUES('sub_other',1);
  `);
  assert.equal(effectivePlanOf(db, freeOrg(), { nowSec: 1000 }), PLANS.free);
  db.exec(`
    INSERT INTO billing_stripe_entitlement_decisions VALUES(2,'sub_42',1,5000);
    INSERT INTO billing_stripe_entitlement_claim_heads VALUES('sub_42',2);
  `);
  assert.equal(effectivePlanOf(db, freeOrg(), { nowSec: 1000 }), PLANS.pro);
  db.close();
});

test('static Pro remains an explicit non-Stripe override and never depends on claim-table health', () => {
  const db = database({ withClaims: false });
  const org = { id: 42, plan: 'pro' };
  assert.equal(effectivePlanOf(db, org, { nowSec: 1000 }), PLANS.pro);
  assert.equal(wouldExceed(db, org, 'projects', { nowSec: 1000 }), false);
  db.close();
});

test('missing or unreadable claim tables fail closed to the stored plan rather than manufacturing Pro', () => {
  const db = database({ withClaims: false });
  assert.equal(effectivePlanOf(db, freeOrg(), { nowSec: 1000 }), PLANS.free);
  assert.equal(wouldExceed(db, freeOrg(), 'projects', { nowSec: 1000 }), true);
  db.close();
});

test('configured claim database makes existing planOf consumers report the same reversible effective plan', () => {
  const db = database();
  db.exec(`
    INSERT INTO billing_stripe_entitlement_decisions VALUES(1,'sub_42',1,4102444800);
    INSERT INTO billing_stripe_entitlement_claim_heads VALUES('sub_42',1);
  `);
  configureBillingEntitlementDatabase(db);
  assert.equal(planOf(freeOrg()), PLANS.pro);
  assert.equal(planOf({ id: 42, plan: 'pro' }), PLANS.pro);
  assert.equal(planOf({ plan: 'free' }), PLANS.free);
  db.exec(`
    INSERT INTO billing_stripe_entitlement_decisions VALUES(2,'sub_42',0,NULL);
    UPDATE billing_stripe_entitlement_claim_heads SET decision_id=2 WHERE subscription_id='sub_42';
  `);
  assert.equal(planOf(freeOrg()), PLANS.free);
  db.close();
});

test('effective-plan authority and clock inputs are bounded before entitlement lookup', () => {
  const db = database();
  assert.throws(() => configureBillingEntitlementDatabase(null), TypeError);
  for (const org of [null, {}, { id: 0, plan: 'free' }, { id: '42', plan: 'free' }]) {
    assert.throws(() => effectivePlanOf(db, org, { nowSec: 1000 }), TypeError);
  }
  for (const nowSec of [-1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => effectivePlanOf(db, freeOrg(), { nowSec }), TypeError);
  }
  assert.throws(() => effectivePlanOf(null, freeOrg(), { nowSec: 1000 }), TypeError);
  db.close();
});
