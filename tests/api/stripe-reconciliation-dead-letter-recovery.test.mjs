import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.STRIPE_SECRET_KEY = 'sk_test_dead_letter_recovery';
delete process.env.ORCHESTRATOR_URL;

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

const request = (path, options = {}) => app.request(path, {
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});
const jsonBody = (value) => JSON.stringify(value);

async function signup(email, name) {
  const response = await request('/api/auth/signup', {
    method: 'POST',
    body: jsonBody({ email, password: 'password123', name }),
  });
  assert.equal(response.status, 200, `signup succeeds for ${email}`);
  const payload = await response.json();
  const me = await request('/api/me', {
    headers: { authorization: `Bearer ${payload.token}` },
  });
  const identity = await me.json();
  return {
    token: payload.token,
    userId: identity.user.id,
    organizationId: identity.orgs[0].id,
  };
}

function seedDeadLetter({ organizationId, eventId, subscriptionId, customerId }) {
  db.prepare(`
    INSERT INTO billing_stripe_customers(customer_id, organization_id, first_observed_at_ms)
    VALUES(?,?,?)
  `).run(customerId, organizationId, 1_000);
  db.prepare(`
    INSERT INTO billing_stripe_subscriptions(subscription_id, customer_id, first_observed_at_ms)
    VALUES(?,?,?)
  `).run(subscriptionId, customerId, 1_000);
  db.prepare(`
    INSERT INTO billing_stripe_webhook_events(
      event_id, provider_created_at_sec, event_type, object_id, object_type,
      api_version, request_id, payload_sha256, first_received_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    eventId,
    1_787_000_000,
    'customer.subscription.updated',
    subscriptionId,
    'subscription',
    '2025-03-31.basil',
    null,
    'b'.repeat(64),
    1_000,
  );
  db.prepare(`
    INSERT INTO billing_stripe_reconciliation_triggers(
      event_id, subscription_id, queued_at_ms, processing_state
    ) VALUES(?,?,?,'pending')
  `).run(eventId, subscriptionId, 1_000);
  db.prepare(`
    INSERT INTO billing_stripe_reconciliation_jobs(
      event_id, processing_state, attempt_count, next_attempt_at_ms,
      lease_token_sha256, lease_expires_at_ms, completed_at_ms,
      last_error_code, claim_decision_id
    ) VALUES(?,'dead_letter',5,2000,NULL,NULL,2000,'stripe_reconciliation_failed',NULL)
  `).run(eventId);
  db.prepare(`
    INSERT INTO billing_stripe_reconciliation_attempts(
      event_id, attempt_number, lease_started_at_ms, lease_expires_at_ms,
      finished_at_ms, outcome, error_code
    ) VALUES(?,5,1900,2000,2000,'dead_letter','stripe_reconciliation_failed')
  `).run(eventId);
}

const owner = await signup('recovery-owner@scopeweave.test', 'Recovery Owner');
const member = await signup('recovery-member@scopeweave.test', 'Recovery Member');
db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)')
  .run(owner.organizationId, member.userId, 'member');

const eventId = 'evt_api_dead_letter';
const subscriptionId = 'sub_api_dead_letter';
const customerId = 'cus_api_dead_letter';
seedDeadLetter({ organizationId: owner.organizationId, eventId, subscriptionId, customerId });

let response = await request(`/api/orgs/${owner.organizationId}/billing/reconciliation/dead-letters`);
assert.equal(response.status, 401, 'dead-letter inspection requires authentication');

response = await request(`/api/orgs/${owner.organizationId}/billing/reconciliation/dead-letters`, {
  headers: { authorization: `Bearer ${member.token}` },
});
assert.equal(response.status, 403, 'ordinary members cannot inspect billing recovery operations');

const ownerAuth = { authorization: `Bearer ${owner.token}` };
response = await request(`/api/orgs/${owner.organizationId}/billing/reconciliation/dead-letters`, {
  headers: ownerAuth,
});
assert.equal(response.status, 200, 'workspace owner can inspect its dead-letter backlog');
let payload = await response.json();
assert.deepEqual(payload, {
  deadLetters: [{
    eventId,
    subscriptionId,
    attemptCount: 5,
    completedAtMs: 2_000,
    lastErrorCode: 'stripe_reconciliation_failed',
  }],
});

response = await request(
  `/api/orgs/${member.organizationId}/billing/reconciliation/dead-letters/${eventId}/retry`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${member.token}` },
    body: jsonBody({ evidenceReference: 'INC-foreign-tenant' }),
  },
);
assert.equal(response.status, 404, 'a foreign workspace cannot learn or recover another tenant dead letter');

response = await request(
  `/api/orgs/${owner.organizationId}/billing/reconciliation/dead-letters/${eventId}/retry`,
  {
    method: 'POST',
    headers: ownerAuth,
    body: jsonBody({ evidenceReference: 'bad\nreference' }),
  },
);
assert.equal(response.status, 400, 'recovery requires a bounded control-free evidence reference');

const originalFetch = globalThis.fetch;
let providerCalls = 0;
const nowSec = Math.floor(Date.now() / 1000);
globalThis.fetch = async (url, options) => {
  providerCalls += 1;
  assert.equal(url, `https://api.stripe.com/v1/subscriptions/${subscriptionId}`);
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, 'Bearer sk_test_dead_letter_recovery');
  const body = JSON.stringify({
    id: subscriptionId,
    object: 'subscription',
    customer: customerId,
    status: 'trialing',
    metadata: { orgId: String(owner.organizationId) },
    cancel_at_period_end: false,
    current_period_start: nowSec - 60,
    current_period_end: nowSec + 3_600,
    canceled_at: null,
    ended_at: null,
    trial_end: nowSec + 3_600,
    latest_invoice: null,
    items: { data: [{ price: { id: 'price_scopeweave_trial' } }] },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
    },
  });
};

try {
  response = await request(
    `/api/orgs/${owner.organizationId}/billing/reconciliation/dead-letters/${eventId}/retry`,
    {
      method: 'POST',
      headers: ownerAuth,
      body: jsonBody({ evidenceReference: 'INC-2026-API-0001' }),
    },
  );
  assert.equal(response.status, 200, 'authorized recovery performs one current-provider reconciliation');
  payload = await response.json();
  assert.equal(payload.status, 'succeeded');
  assert.equal(payload.replayed, false);
  assert.equal(payload.eventId, eventId);
  assert.equal(payload.subscriptionId, subscriptionId);
  assert.equal(payload.attemptNumber, 6);
  assert.ok(Number.isSafeInteger(payload.recoveryId) && payload.recoveryId > 0);
  assert.ok(Number.isSafeInteger(payload.claimDecisionId) && payload.claimDecisionId > 0);
  assert.equal(providerCalls, 1);

  response = await request(
    `/api/orgs/${owner.organizationId}/billing/reconciliation/dead-letters/${eventId}/retry`,
    {
      method: 'POST',
      headers: ownerAuth,
      body: jsonBody({ evidenceReference: 'INC-2026-API-0001' }),
    },
  );
  assert.equal(response.status, 200, 'replaying the same operator evidence is idempotent');
  const replay = await response.json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.recoveryId, payload.recoveryId);
  assert.equal(replay.claimDecisionId, payload.claimDecisionId);
  assert.equal(providerCalls, 1, 'idempotent replay does not repeat Stripe provider reads');
} finally {
  globalThis.fetch = originalFetch;
}

response = await request(`/api/orgs/${owner.organizationId}/billing/reconciliation/dead-letters`, {
  headers: ownerAuth,
});
payload = await response.json();
assert.deepEqual(payload.deadLetters, [], 'successful manual recovery clears the dead-letter backlog');

const durableRecovery = db.prepare(`
  SELECT actor_user_id, evidence_reference, attempt_number
    FROM billing_stripe_reconciliation_recoveries
   WHERE event_id = ?
`).get(eventId);
assert.deepEqual({ ...durableRecovery }, {
  actor_user_id: owner.userId,
  evidence_reference: 'INC-2026-API-0001',
  attempt_number: 6,
});

db.close();
