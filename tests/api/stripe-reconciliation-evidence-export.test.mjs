import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_PUBLIC_ORIGIN = 'https://scopeweave.test';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.STRIPE_SECRET_KEY = 'sk_test_evidence_export';
process.env.STRIPE_PRICE_ID = 'price_evidence_export';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_evidence_export';
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

function seedEvidence({
  organizationId,
  actorUserId,
  eventId,
  subscriptionId,
  customerId,
  payloadSha256,
  queuedAtMs,
  evidenceReference,
}) {
  db.prepare(`
    INSERT INTO billing_stripe_customers(customer_id, organization_id, first_observed_at_ms)
    VALUES(?,?,?)
  `).run(customerId, organizationId, queuedAtMs - 100);
  db.prepare(`
    INSERT INTO billing_stripe_subscriptions(subscription_id, customer_id, first_observed_at_ms)
    VALUES(?,?,?)
  `).run(subscriptionId, customerId, queuedAtMs - 100);
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
    payloadSha256,
    queuedAtMs - 10,
  );
  db.prepare(`
    INSERT INTO billing_stripe_reconciliation_triggers(
      event_id, subscription_id, queued_at_ms, processing_state
    ) VALUES(?,?,?,'pending')
  `).run(eventId, subscriptionId, queuedAtMs);
  db.prepare(`
    INSERT INTO billing_stripe_reconciliation_jobs(
      event_id, processing_state, attempt_count, next_attempt_at_ms,
      lease_token_sha256, lease_expires_at_ms, completed_at_ms,
      last_error_code, claim_decision_id
    ) VALUES(?,'dead_letter',1,?,NULL,NULL,?,'stripe_reconciliation_failed',NULL)
  `).run(eventId, queuedAtMs + 10, queuedAtMs + 20);
  db.prepare(`
    INSERT INTO billing_stripe_reconciliation_attempts(
      event_id, attempt_number, lease_started_at_ms, lease_expires_at_ms,
      finished_at_ms, outcome, error_code
    ) VALUES(?,1,?,?,?,'dead_letter','stripe_reconciliation_failed')
  `).run(eventId, queuedAtMs + 1, queuedAtMs + 11, queuedAtMs + 20);
  db.prepare(`
    INSERT INTO billing_stripe_reconciliation_recoveries(
      event_id, attempt_number, actor_user_id, evidence_reference,
      requested_at_ms, completed_at_ms, outcome, error_code, claim_decision_id
    ) VALUES(?,1,?,?,?,?,'dead_letter','stripe_reconciliation_failed',NULL)
  `).run(eventId, actorUserId, evidenceReference, queuedAtMs + 30, queuedAtMs + 40);
}

const owner = await signup('export-owner@scopeweave.test', 'Export Owner');
const member = await signup('export-member@scopeweave.test', 'Export Member');
db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)')
  .run(owner.organizationId, member.userId, 'member');

seedEvidence({
  organizationId: owner.organizationId,
  actorUserId: owner.userId,
  eventId: 'evt_export_owner',
  subscriptionId: 'sub_export_owner',
  customerId: 'cus_export_owner',
  payloadSha256: 'a'.repeat(64),
  queuedAtMs: 2_000,
  evidenceReference: 'INC-PRIVATE-EXPORT-OWNER',
});
seedEvidence({
  organizationId: member.organizationId,
  actorUserId: member.userId,
  eventId: 'evt_export_foreign',
  subscriptionId: 'sub_export_foreign',
  customerId: 'cus_export_foreign',
  payloadSha256: 'b'.repeat(64),
  queuedAtMs: 3_000,
  evidenceReference: 'INC-PRIVATE-EXPORT-FOREIGN',
});

const ownerPath = `/api/orgs/${owner.organizationId}/billing/reconciliation/evidence`;
let response = await request(ownerPath);
assert.equal(response.status, 401, 'evidence export requires authentication');

response = await request(ownerPath, {
  headers: { authorization: `Bearer ${member.token}` },
});
assert.equal(response.status, 403, 'ordinary members cannot export workspace billing evidence');

response = await request(`${ownerPath}?limit=0`, {
  headers: { authorization: `Bearer ${owner.token}` },
});
assert.equal(response.status, 400, 'invalid export bounds fail closed');
assert.deepEqual(await response.json(), { error: 'stripe_reconciliation_evidence_export_invalid' });

assert.equal(
  db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'billing.reconciliation.evidence_export'")
    .get().count,
  0,
  'denied and invalid requests do not create successful-export audit records',
);

response = await request(ownerPath, {
  headers: { authorization: `Bearer ${owner.token}` },
});
assert.equal(response.status, 200, 'workspace owner can export its reconciliation evidence');
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
assert.equal(
  response.headers.get('content-disposition'),
  'attachment; filename="scopeweave-stripe-reconciliation-evidence.json"',
);
const ownerReportBody = await response.text();
const ownerReport = JSON.parse(ownerReportBody);
const ownerReportSha256 = createHash('sha256')
  .update(ownerReportBody, 'utf8')
  .digest('hex');
assert.equal(ownerReport.schemaVersion, 'scopeweave.stripe-reconciliation-evidence/v1');
assert.equal(ownerReport.organizationId, owner.organizationId);
assert.deepEqual(ownerReport.events.map((event) => event.eventId), ['evt_export_owner']);
assert.equal(JSON.stringify(ownerReport).includes('evt_export_foreign'), false);
assert.equal(JSON.stringify(ownerReport).includes('INC-PRIVATE-EXPORT-OWNER'), false);
assert.equal(
  ownerReport.events[0].recoveries[0].evidenceReferenceSha256,
  createHash('sha256').update('INC-PRIVATE-EXPORT-OWNER', 'utf8').digest('hex'),
);

const ownerAudit = db.prepare(`
  SELECT org_id, user_id, target_type, target_id, meta
    FROM audit_log
   WHERE action = 'billing.reconciliation.evidence_export'
     AND org_id = ? AND user_id = ?
`).get(owner.organizationId, owner.userId);
assert.ok(ownerAudit, 'each successful evidence export is durably access-logged');
assert.equal(ownerAudit.target_type, 'organization');
assert.equal(ownerAudit.target_id, String(owner.organizationId));
assert.deepEqual(JSON.parse(ownerAudit.meta), {
  schemaVersion: 'scopeweave.stripe-reconciliation-evidence/v1',
  eventCount: 1,
  evidenceDocumentSha256: ownerReportSha256,
});
assert.equal(
  JSON.stringify(ownerAudit).includes('INC-PRIVATE-EXPORT-OWNER'),
  false,
  'export audit metadata never copies private recovery evidence text',
);

response = await request(
  `/api/orgs/${member.organizationId}/billing/reconciliation/evidence`,
  { headers: { authorization: `Bearer ${member.token}` } },
);
assert.equal(response.status, 200, 'a second tenant owner can export only its own evidence');
const memberReport = await response.json();
assert.deepEqual(memberReport.events.map((event) => event.eventId), ['evt_export_foreign']);
assert.equal(JSON.stringify(memberReport).includes('evt_export_owner'), false);
assert.equal(
  db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'billing.reconciliation.evidence_export'")
    .get().count,
  2,
  'successful exports are independently logged for each tenant actor',
);

db.exec('DROP TABLE audit_log');
response = await request(ownerPath, {
  headers: { authorization: `Bearer ${owner.token}` },
});
assert.equal(response.status, 500, 'evidence disclosure fails closed when its audit sink is unavailable');
assert.deepEqual(await response.json(), {
  error: 'stripe_reconciliation_evidence_export_audit_failed',
});

db.close();
