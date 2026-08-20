import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.ORCHESTRATOR_URL;

// Import the real public application bootstrap first. It is responsible for
// composing the shared database and billing authority before requests can use
// the legacy route graph.
await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');
const { PLANS, planOf } = await import('../../server/billing.mjs');

// Do not manually call configureBillingEntitlementDatabase here: this contract
// proves production application bootstrap wires claim-backed plan authority.
db.prepare('INSERT INTO users(id,email,password_hash,name) VALUES(?,?,?,?)')
  .run(9001, 'bootstrap-plan@example.test', 'hash', 'Bootstrap Plan');
db.prepare('INSERT INTO orgs(id,name,owner_id,plan) VALUES(?,?,?,?)')
  .run(9101, 'Bootstrap Org', 9001, 'free');

db.prepare(`
  INSERT INTO billing_stripe_customers(customer_id, organization_id, first_observed_at_ms)
  VALUES(?,?,?)
`).run('cus_bootstrap', 9101, 1);
db.prepare(`
  INSERT INTO billing_stripe_subscriptions(subscription_id, customer_id, first_observed_at_ms)
  VALUES(?,?,?)
`).run('sub_bootstrap', 'cus_bootstrap', 1);

const nowSec = Math.floor(Date.now() / 1000);
const validUntilSec = nowSec + 3600;
const observationId = Number(db.prepare(`
  INSERT INTO billing_stripe_subscription_observations(
    subscription_id, source_event_id, observed_at_ms, subscription_status,
    cancel_at_period_end, current_period_start_sec, current_period_end_sec,
    canceled_at_sec, ended_at_sec, trial_end_sec, latest_invoice_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
`).run(
  'sub_bootstrap', null, 1, 'active', 0, nowSec - 60, validUntilSec,
  null, null, null, null,
).lastInsertRowid);

const decisionId = Number(db.prepare(`
  INSERT INTO billing_stripe_entitlement_decisions(
    subscription_id, evaluated_subscription_observation_id, evaluated_invoice_observation_id,
    previous_decision_id, decision_action, decision_reason, entitled, valid_until_sec,
    claim_subscription_observation_id, claim_invoice_observation_id,
    evaluated_at_sec, recorded_at_ms
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  'sub_bootstrap', observationId, null, null, 'grant', 'bootstrap-binding-regression', 1,
  validUntilSec, observationId, null, nowSec, Date.now(),
).lastInsertRowid);
db.prepare(`
  INSERT INTO billing_stripe_entitlement_claim_heads(subscription_id, decision_id)
  VALUES(?,?)
`).run('sub_bootstrap', decisionId);

const organization = db.prepare('SELECT id, plan FROM orgs WHERE id = ?').get(9101);
assert.equal(
  planOf(organization),
  PLANS.pro,
  'production application bootstrap must bind current claim evidence into planOf consumers',
);

db.close();
console.log('✓ billing effective-plan bootstrap binding passed');
