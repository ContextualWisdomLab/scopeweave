import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.ORCHESTRATOR_URL;

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

const req = (path, opts = {}) => app.request(path, {
  ...opts,
  headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
});
const body = (value) => JSON.stringify(value);

const signup = await req('/api/auth/signup', {
  method: 'POST',
  body: body({ email: 'billing-status@example.com', password: 'password123', name: 'Billing status' }),
});
assert.equal(signup.status, 200, 'signup succeeds');
const { token } = await signup.json();
const auth = { authorization: `Bearer ${token}` };

const meResponse = await req('/api/me', { headers: auth });
assert.equal(meResponse.status, 200, 'current user can resolve its workspace');
const me = await meResponse.json();
const organizationId = me.orgs[0].id;
assert.equal(me.orgs[0].plan, 'free', 'durable organization plan remains the stored free value');

const nowSec = Math.floor(Date.now() / 1000);
const validUntilSec = nowSec + 3600;

db.prepare(`
  INSERT INTO billing_stripe_customers(customer_id, organization_id, first_observed_at_ms)
  VALUES(?,?,?)
`).run('cus_status', organizationId, 1);
db.prepare(`
  INSERT INTO billing_stripe_subscriptions(subscription_id, customer_id, first_observed_at_ms)
  VALUES(?,?,?)
`).run('sub_status', 'cus_status', 1);
const subscriptionObservationId = Number(db.prepare(`
  INSERT INTO billing_stripe_subscription_observations(
    subscription_id, source_event_id, observed_at_ms, subscription_status,
    cancel_at_period_end, current_period_start_sec, current_period_end_sec,
    canceled_at_sec, ended_at_sec, trial_end_sec, latest_invoice_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
`).run('sub_status', null, 1, 'active', 0, nowSec - 60, validUntilSec, null, null, null, null).lastInsertRowid);
const grantDecisionId = Number(db.prepare(`
  INSERT INTO billing_stripe_entitlement_decisions(
    subscription_id, evaluated_subscription_observation_id, evaluated_invoice_observation_id,
    previous_decision_id, decision_action, decision_reason, entitled, valid_until_sec,
    claim_subscription_observation_id, claim_invoice_observation_id,
    evaluated_at_sec, recorded_at_ms
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  'sub_status', subscriptionObservationId, null, null, 'grant', 'api-status-regression', 1,
  validUntilSec, subscriptionObservationId, null, nowSec, Date.now(),
).lastInsertRowid);
db.prepare(`
  INSERT INTO billing_stripe_entitlement_claim_heads(subscription_id, decision_id)
  VALUES(?,?)
`).run('sub_status', grantDecisionId);

let billingResponse = await req(`/api/orgs/${organizationId}/billing`, { headers: auth });
assert.equal(billingResponse.status, 200, 'billing status remains available with a current claim');
let billing = await billingResponse.json();
assert.equal(billing.plan, 'pro', 'buyer-visible plan reports the current claim-backed effective plan');
assert.equal(billing.storedPlan, 'free', 'stored/manual plan remains separately auditable');
assert.equal(billing.planName, 'Pro');
assert.equal(billing.limits.projects, null, 'effective Pro limits match authorization behavior');
assert.equal(billing.limits.members, null, 'effective Pro limits match authorization behavior');

const revokeDecisionId = Number(db.prepare(`
  INSERT INTO billing_stripe_entitlement_decisions(
    subscription_id, evaluated_subscription_observation_id, evaluated_invoice_observation_id,
    previous_decision_id, decision_action, decision_reason, entitled, valid_until_sec,
    claim_subscription_observation_id, claim_invoice_observation_id,
    evaluated_at_sec, recorded_at_ms
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  'sub_status', subscriptionObservationId, null, grantDecisionId, 'revoke', 'api-status-revoked', 0,
  null, subscriptionObservationId, null, nowSec, Date.now(),
).lastInsertRowid);
db.prepare(`
  UPDATE billing_stripe_entitlement_claim_heads
  SET decision_id = ?
  WHERE subscription_id = ?
`).run(revokeDecisionId, 'sub_status');

billingResponse = await req(`/api/orgs/${organizationId}/billing`, { headers: auth });
assert.equal(billingResponse.status, 200, 'billing status remains available after revocation');
billing = await billingResponse.json();
assert.equal(billing.plan, 'free', 'revocation immediately returns buyer-visible plan truth to Free');
assert.equal(billing.storedPlan, 'free');
assert.equal(billing.planName, 'Free');
assert.equal(billing.limits.projects, 2);
assert.equal(billing.limits.members, 3);

db.prepare('UPDATE orgs SET plan = ? WHERE id = ?').run('pro', organizationId);
billingResponse = await req(`/api/orgs/${organizationId}/billing`, { headers: auth });
billing = await billingResponse.json();
assert.equal(billing.plan, 'pro', 'explicit manual Pro remains visible independently of Stripe claims');
assert.equal(billing.storedPlan, 'pro');
assert.equal(billing.planName, 'Pro');

db.close();
