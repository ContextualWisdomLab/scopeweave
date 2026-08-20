import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  StripeEntitlementClaimError,
  createSqliteStripeEntitlementClaimRepository,
  installStripeEntitlementClaimSchema,
} from '../../server/stripe_entitlement_claim_ledger.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE orgs(id INTEGER PRIMARY KEY);
    CREATE TABLE billing_stripe_customers(customer_id TEXT PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES orgs(id));
    CREATE TABLE billing_stripe_subscriptions(subscription_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES billing_stripe_customers(customer_id));
    CREATE TABLE billing_stripe_subscription_observations(
      observation_id INTEGER PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES billing_stripe_subscriptions(subscription_id),
      subscription_status TEXT NOT NULL, cancel_at_period_end INTEGER NOT NULL,
      current_period_end_sec INTEGER NOT NULL, trial_end_sec INTEGER, latest_invoice_id TEXT
    );
    CREATE TABLE billing_stripe_invoices(invoice_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES billing_stripe_subscriptions(subscription_id));
    CREATE TABLE billing_stripe_invoice_observations(
      observation_id INTEGER PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES billing_stripe_invoices(invoice_id),
      invoice_status TEXT NOT NULL
    );
    INSERT INTO orgs VALUES(42),(77);
    INSERT INTO billing_stripe_customers VALUES('cus_42',42),('cus_77',77);
    INSERT INTO billing_stripe_subscriptions VALUES('sub_42','cus_42'),('sub_77','cus_77');
    INSERT INTO billing_stripe_subscription_observations VALUES
      (101,'sub_42','active',0,2000,NULL,'in_42'),
      (102,'sub_42','active',0,3000,NULL,'in_42'),
      (201,'sub_77','active',0,4000,NULL,'in_77');
    INSERT INTO billing_stripe_invoices VALUES('in_42','sub_42'),('in_77','sub_77');
    INSERT INTO billing_stripe_invoice_observations VALUES
      (501,'in_42','open'),(502,'in_42','paid'),(701,'in_77','paid');
  `);
  installStripeEntitlementClaimSchema(db);
  return db;
}

function expectCode(code, status) {
  return (error) => {
    assert.ok(error instanceof StripeEntitlementClaimError);
    assert.equal(error.code, code);
    if (status != null) assert.equal(error.status, status);
    return true;
  };
}

function paidPolicy({ subscription, invoice, previousClaim, nowSec }) {
  assert.equal(subscription.observationId, 102);
  assert.equal(subscription.organizationId, 42);
  assert.equal(subscription.subscriptionId, 'sub_42');
  assert.equal(subscription.status, 'active');
  assert.equal(subscription.cancelAtPeriodEnd, false);
  assert.equal(subscription.currentPeriodEndSec, 3000);
  assert.equal(subscription.latestInvoiceId, 'in_42');
  assert.deepEqual(invoice, { invoiceId: 'in_42', subscriptionId: 'sub_42', status: 'paid' });
  assert.equal(nowSec, 1000);
  return {
    action: previousClaim ? 'retain' : 'grant', reason: 'paid_active_subscription',
    claim: previousClaim ?? {
      organizationId: 42, subscriptionId: 'sub_42', entitled: true, validUntilSec: 3000,
      sourceObservationId: 102, sourceInvoiceId: 'in_42',
    },
  };
}

test('schema is normalized append-only decision history plus one current head and has no plan/session authority', () => {
  const db = fixture();
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE 'billing_stripe_entitlement_%'").all();
  assert.deepEqual(rows.map(({ name }) => name).sort(), ['billing_stripe_entitlement_claim_heads','billing_stripe_entitlement_decisions']);
  const sql = rows.map(({ sql }) => sql).join('\n');
  assert.match(sql, /previous_decision_id/);
  assert.match(sql, /claim_subscription_observation_id/);
  assert.doesNotMatch(sql, /orgs\.plan|token|session|permission|role/iu);
  db.close();
});

test('repository chooses current persisted Subscription and Invoice evidence and atomically stores a grant head', () => {
  const db = fixture();
  const repo = createSqliteStripeEntitlementClaimRepository(db, { deriveEntitlement: paidPolicy, nowSec: () => 1000, nowMs: () => 1000000 });
  const claim = repo.applyCurrentDecision({ organizationId: 42, subscriptionId: 'sub_42', expectedPreviousDecisionId: null });
  assert.deepEqual(claim, {
    decisionId: 1, organizationId: 42, subscriptionId: 'sub_42', entitled: true, validUntilSec: 3000,
    sourceObservationId: 102, sourceInvoiceId: 'in_42', sourceInvoiceObservationId: 502,
    action: 'grant', reason: 'paid_active_subscription', evaluatedSubscriptionObservationId: 102,
    evaluatedInvoiceObservationId: 502, evaluatedAtSec: 1000,
  });
  assert.ok(Object.isFrozen(claim));
  assert.deepEqual(repo.getCurrentClaim({ organizationId: 42, subscriptionId: 'sub_42' }), claim);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM billing_stripe_entitlement_decisions').get().count, 1);
  assert.equal(db.prepare('SELECT decision_id FROM billing_stripe_entitlement_claim_heads WHERE subscription_id=?').get('sub_42').decision_id, 1);
  db.close();
});

test('subsequent decision receives durable previous claim and CAS advances one audit chain', () => {
  const db = fixture();
  let calls = 0;
  const policy = (input) => {
    calls += 1;
    if (calls === 1) return paidPolicy(input);
    assert.deepEqual(input.previousClaim, {
      organizationId: 42, subscriptionId: 'sub_42', entitled: true, validUntilSec: 3000,
      sourceObservationId: 102, sourceInvoiceId: 'in_42',
    });
    return { action: 'retain', reason: 'paid_active_subscription', claim: input.previousClaim };
  };
  const repo = createSqliteStripeEntitlementClaimRepository(db, { deriveEntitlement: policy, nowSec: () => 1000, nowMs: () => 1000000 });
  const first = repo.applyCurrentDecision({ organizationId: 42, subscriptionId: 'sub_42' });
  const second = repo.applyCurrentDecision({ organizationId: 42, subscriptionId: 'sub_42', expectedPreviousDecisionId: first.decisionId });
  assert.equal(second.decisionId, 2);
  assert.equal(second.action, 'retain');
  assert.equal(second.sourceInvoiceObservationId, 502);
  assert.equal(db.prepare('SELECT previous_decision_id FROM billing_stripe_entitlement_decisions WHERE decision_id=2').get().previous_decision_id, 1);
  assert.equal(db.prepare('SELECT decision_id FROM billing_stripe_entitlement_claim_heads WHERE subscription_id=?').get('sub_42').decision_id, 2);
  db.close();
});

test('optimistic concurrency, tenant isolation, and unknown subscriptions fail closed without appending', () => {
  const db = fixture();
  const repo = createSqliteStripeEntitlementClaimRepository(db, { deriveEntitlement: paidPolicy, nowSec: () => 1000, nowMs: () => 1000 });
  const first = repo.applyCurrentDecision({ organizationId: 42, subscriptionId: 'sub_42' });
  assert.throws(() => repo.applyCurrentDecision({ organizationId: 42, subscriptionId: 'sub_42', expectedPreviousDecisionId: null }), expectCode('stripe_entitlement_claim_conflict',409));
  assert.equal(repo.getCurrentClaim({ organizationId: 77, subscriptionId: 'sub_42' }), null);
  assert.throws(() => repo.applyCurrentDecision({ organizationId: 42, subscriptionId: 'sub_missing' }), expectCode('stripe_entitlement_subscription_unknown',404));
  assert.equal(db.prepare('SELECT COUNT(*) count FROM billing_stripe_entitlement_decisions').get().count, 1);
  assert.equal(first.decisionId, 1);
  db.close();
});

test('trial/no-invoice decisions persist null Invoice provenance and false claims persist null validity', () => {
  const db = fixture();
  db.exec("INSERT INTO billing_stripe_subscription_observations VALUES(103,'sub_42','trialing',0,3000,2500,NULL)");
  let phase = 0;
  const policy = ({ subscription, invoice }) => {
    phase += 1;
    assert.equal(subscription.observationId, 103);
    assert.equal(invoice, null);
    if (phase === 1) return { action: 'grant', reason: 'trialing', claim: { organizationId:42, subscriptionId:'sub_42', entitled:true, validUntilSec:2500, sourceObservationId:103, sourceInvoiceId:null } };
    return { action: 'revoke', reason: 'trial_not_usable', claim: { organizationId:42, subscriptionId:'sub_42', entitled:false, validUntilSec:null, sourceObservationId:103, sourceInvoiceId:null } };
  };
  const repo = createSqliteStripeEntitlementClaimRepository(db, { deriveEntitlement: policy, nowSec: () => 1000, nowMs: () => 1000 });
  const first = repo.applyCurrentDecision({ organizationId:42, subscriptionId:'sub_42' });
  const second = repo.applyCurrentDecision({ organizationId:42, subscriptionId:'sub_42', expectedPreviousDecisionId:first.decisionId });
  assert.equal(first.sourceInvoiceId, null);
  assert.equal(first.evaluatedInvoiceObservationId, null);
  assert.equal(second.entitled, false);
  assert.equal(second.validUntilSec, null);
  db.close();
});

test('malformed policy output and impossible claim provenance fail closed with no decision', () => {
  const badPolicies = [
    () => null,
    () => ({ action:'boom', reason:'x', claim:{} }),
    () => ({ action:'grant', reason:'', claim:{} }),
    () => ({ action:'grant', reason:'x', claim:null }),
    () => ({ action:'grant', reason:'x', claim:{ organizationId:42, subscriptionId:'sub_42', entitled:'yes', validUntilSec:3000, sourceObservationId:102, sourceInvoiceId:'in_42' } }),
    () => ({ action:'grant', reason:'x', claim:{ organizationId:42, subscriptionId:'sub_42', entitled:true, validUntilSec:null, sourceObservationId:102, sourceInvoiceId:'in_42' } }),
    () => ({ action:'grant', reason:'x', claim:{ organizationId:77, subscriptionId:'sub_42', entitled:true, validUntilSec:3000, sourceObservationId:102, sourceInvoiceId:'in_42' } }),
    () => ({ action:'grant', reason:'x', claim:{ organizationId:42, subscriptionId:'sub_42', entitled:true, validUntilSec:3000, sourceObservationId:999, sourceInvoiceId:'in_42' } }),
    () => ({ action:'grant', reason:'x', claim:{ organizationId:42, subscriptionId:'sub_42', entitled:true, validUntilSec:3000, sourceObservationId:102, sourceInvoiceId:'in_wrong' } }),
  ];
  for (const deriveEntitlement of badPolicies) {
    const db = fixture();
    const repo = createSqliteStripeEntitlementClaimRepository(db, { deriveEntitlement, nowSec: () => 1000, nowMs: () => 1000 });
    assert.throws(() => repo.applyCurrentDecision({ organizationId:42, subscriptionId:'sub_42' }), expectCode('stripe_entitlement_policy_invalid',500));
    assert.equal(db.prepare('SELECT COUNT(*) count FROM billing_stripe_entitlement_decisions').get().count, 0);
    db.close();
  }
});

test('missing current Invoice observation is passed to policy as absent evidence', () => {
  const db = fixture();
  db.exec("INSERT INTO billing_stripe_invoices VALUES('in_missing_obs','sub_42')");
  db.exec("INSERT INTO billing_stripe_subscription_observations VALUES(103,'sub_42','active',0,3500,NULL,'in_missing_obs')");
  const repo = createSqliteStripeEntitlementClaimRepository(db, {
    deriveEntitlement({ subscription, invoice }) {
      assert.equal(subscription.observationId, 103);
      assert.equal(subscription.latestInvoiceId, 'in_missing_obs');
      assert.equal(invoice, null);
      return { action:'deny', reason:'paid_invoice_evidence_required', claim:{ organizationId:42, subscriptionId:'sub_42', entitled:false, validUntilSec:null, sourceObservationId:103, sourceInvoiceId:null } };
    },
    nowSec:()=>1000, nowMs:()=>1000,
  });
  const claim=repo.applyCurrentDecision({organizationId:42,subscriptionId:'sub_42'});
  assert.equal(claim.evaluatedInvoiceObservationId,null);
  assert.equal(claim.entitled,false);
  db.close();
});

test('retaining prior paid evidence preserves its exact Invoice observation when current Subscription has no Invoice', () => {
  const db = fixture();
  let phase = 0;
  const policy = ({ subscription, invoice, previousClaim }) => {
    phase += 1;
    if (phase === 1) return paidPolicy({ subscription, invoice, previousClaim, nowSec: 1000 });
    assert.equal(subscription.observationId, 103);
    assert.equal(subscription.status, 'past_due');
    assert.equal(invoice, null);
    assert.equal(previousClaim.sourceInvoiceId, 'in_42');
    return { action: 'retain', reason: 'past_due_no_extension', claim: previousClaim };
  };
  const repo = createSqliteStripeEntitlementClaimRepository(db, { deriveEntitlement: policy, nowSec: () => 1000, nowMs: () => 1000 });
  const first = repo.applyCurrentDecision({ organizationId:42, subscriptionId:'sub_42' });
  db.exec("INSERT INTO billing_stripe_subscription_observations VALUES(103,'sub_42','past_due',0,3000,NULL,NULL)");
  const second = repo.applyCurrentDecision({ organizationId:42, subscriptionId:'sub_42', expectedPreviousDecisionId:first.decisionId });
  assert.equal(second.sourceInvoiceId, 'in_42');
  assert.equal(second.sourceInvoiceObservationId, 502);
  assert.equal(second.evaluatedInvoiceObservationId, null);
  db.close();
});

test('malformed authority, dependency seams, and clocks fail before durable work', () => {
  assert.throws(() => createSqliteStripeEntitlementClaimRepository(null,{deriveEntitlement(){}}), TypeError);
  const db = fixture();
  assert.throws(() => createSqliteStripeEntitlementClaimRepository(db), TypeError);
  assert.throws(() => createSqliteStripeEntitlementClaimRepository(db,{deriveEntitlement(){},nowSec:null}), TypeError);
  const repo = createSqliteStripeEntitlementClaimRepository(db, { deriveEntitlement: paidPolicy, nowSec: () => -1, nowMs: () => 0 });
  assert.throws(() => repo.applyCurrentDecision({ organizationId:42, subscriptionId:'sub_42' }), expectCode('stripe_entitlement_claim_invalid',400));
  for (const input of [
    { organizationId:0, subscriptionId:'sub_42' }, { organizationId:'42', subscriptionId:'sub_42' },
    { organizationId:42, subscriptionId:'' }, { organizationId:42, subscriptionId:'sub bad' },
  ]) assert.throws(() => repo.getCurrentClaim(input), StripeEntitlementClaimError);
  const goodClockRepo = createSqliteStripeEntitlementClaimRepository(db, { deriveEntitlement: paidPolicy, nowSec: () => 1000, nowMs: () => 1000 });
  assert.throws(() => goodClockRepo.applyCurrentDecision({ organizationId:42, subscriptionId:'sub_42', expectedPreviousDecisionId:0 }), expectCode('stripe_entitlement_claim_invalid',400));
  db.close();
});

test('default clocks are usable and produce bounded audit timestamps', () => {
  const db = fixture();
  const repo = createSqliteStripeEntitlementClaimRepository(db, {
    deriveEntitlement({ subscription, nowSec }) {
      assert.ok(Number.isSafeInteger(nowSec) && nowSec > 0);
      return {
        action: 'deny', reason: 'default_clock_probe',
        claim: { organizationId: 42, subscriptionId: 'sub_42', entitled: false, validUntilSec: null, sourceObservationId: subscription.observationId, sourceInvoiceId: null },
      };
    },
  });
  const claim = repo.applyCurrentDecision({ organizationId: 42, subscriptionId: 'sub_42' });
  assert.ok(claim.evaluatedAtSec > 0);
  const recorded = db.prepare('SELECT recorded_at_ms FROM billing_stripe_entitlement_decisions WHERE decision_id=?').get(claim.decisionId);
  assert.ok(Number(recorded.recorded_at_ms) > 0);
  db.close();
});

test('savepoint cleanup preserves causal insert failure and never releases an unconfirmed rollback', () => {
  const inner = fixture();
  const commands=[];
  let failRollback=false;
  let failCleanupRelease=false;
  const wrapped={
    prepare(sql){
      const stmt=inner.prepare(sql);
      if(sql.includes('INSERT INTO billing_stripe_entitlement_decisions(')) return {run(){throw new Error('causal decision write failure')}};
      return stmt;
    },
    exec(sql){
      commands.push(sql);
      if(sql.startsWith('ROLLBACK TO')&&failRollback) throw new Error('rollback failed');
      if(sql.startsWith('RELEASE')&&failCleanupRelease) throw new Error('cleanup release failed');
      return inner.exec(sql);
    }
  };
  let repo=createSqliteStripeEntitlementClaimRepository(wrapped,{deriveEntitlement:paidPolicy,nowSec:()=>1000,nowMs:()=>1000});
  failCleanupRelease=true;
  assert.throws(()=>repo.applyCurrentDecision({organizationId:42,subscriptionId:'sub_42'}),/causal decision write failure/);
  assert.ok(commands.some(x=>x.startsWith('ROLLBACK TO')));
  assert.ok(commands.some(x=>x.startsWith('RELEASE')));
  inner.exec('ROLLBACK');
  commands.length=0; failCleanupRelease=false; failRollback=true;
  repo=createSqliteStripeEntitlementClaimRepository(wrapped,{deriveEntitlement:paidPolicy,nowSec:()=>1000,nowMs:()=>1000});
  assert.throws(()=>repo.applyCurrentDecision({organizationId:42,subscriptionId:'sub_42'}),/causal decision write failure/);
  assert.ok(commands.some(x=>x.startsWith('ROLLBACK TO')));
  assert.equal(commands.filter(x=>x.startsWith('RELEASE')).length,0);
  inner.close();
});
