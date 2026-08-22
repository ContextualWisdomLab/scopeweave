import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  StripeReconciliationEvidenceExportError,
  createSqliteStripeReconciliationEvidenceExportRepository,
} from '../../server/stripe_reconciliation_evidence_export.mjs';

const db = new DatabaseSync(':memory:');
db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE orgs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE billing_stripe_customers (
    customer_id TEXT PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES orgs(id),
    first_observed_at_ms INTEGER NOT NULL
  );
  CREATE TABLE billing_stripe_subscriptions (
    subscription_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES billing_stripe_customers(customer_id),
    first_observed_at_ms INTEGER NOT NULL
  );
  CREATE TABLE billing_stripe_webhook_events (
    event_id TEXT PRIMARY KEY,
    provider_created_at_sec INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    object_type TEXT NOT NULL,
    api_version TEXT,
    request_id TEXT,
    payload_sha256 TEXT NOT NULL,
    first_received_at_ms INTEGER NOT NULL
  );
  CREATE TABLE billing_stripe_reconciliation_triggers (
    event_id TEXT PRIMARY KEY REFERENCES billing_stripe_webhook_events(event_id),
    subscription_id TEXT NOT NULL,
    queued_at_ms INTEGER NOT NULL,
    processing_state TEXT NOT NULL
  );
  CREATE TABLE billing_stripe_reconciliation_jobs (
    event_id TEXT PRIMARY KEY REFERENCES billing_stripe_reconciliation_triggers(event_id),
    processing_state TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    next_attempt_at_ms INTEGER NOT NULL,
    lease_token_sha256 TEXT,
    lease_expires_at_ms INTEGER,
    completed_at_ms INTEGER,
    last_error_code TEXT,
    claim_decision_id INTEGER
  );
  CREATE TABLE billing_stripe_reconciliation_attempts (
    attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL REFERENCES billing_stripe_reconciliation_jobs(event_id),
    attempt_number INTEGER NOT NULL,
    lease_started_at_ms INTEGER NOT NULL,
    lease_expires_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    outcome TEXT,
    error_code TEXT,
    UNIQUE(event_id, attempt_number)
  );
  CREATE TABLE billing_stripe_reconciliation_recoveries (
    recovery_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    actor_user_id INTEGER NOT NULL,
    evidence_reference TEXT NOT NULL,
    requested_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    outcome TEXT,
    error_code TEXT,
    claim_decision_id INTEGER,
    UNIQUE(event_id, evidence_reference)
  );
`);

db.exec(`
  INSERT INTO orgs(id,name) VALUES(1,'Tenant One'),(2,'Tenant Two');
  INSERT INTO billing_stripe_customers(customer_id,organization_id,first_observed_at_ms)
    VALUES('cus_one',1,100),('cus_two',2,100);
  INSERT INTO billing_stripe_subscriptions(subscription_id,customer_id,first_observed_at_ms)
    VALUES('sub_one','cus_one',100),('sub_two','cus_two',100);

  INSERT INTO billing_stripe_webhook_events(
    event_id,provider_created_at_sec,event_type,object_id,object_type,
    api_version,request_id,payload_sha256,first_received_at_ms
  ) VALUES
    ('evt_one_old',1787000000,'customer.subscription.updated','sub_one','subscription',
      '2025-03-31.basil','req_one_old','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1000),
    ('evt_one_new',1787000100,'invoice.paid','in_one','invoice',
      '2025-03-31.basil',NULL,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',2000),
    ('evt_two',1787000200,'customer.subscription.updated','sub_two','subscription',
      '2025-03-31.basil','req_two','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',3000);

  INSERT INTO billing_stripe_reconciliation_triggers(event_id,subscription_id,queued_at_ms,processing_state)
    VALUES('evt_one_old','sub_one',1100,'pending'),
          ('evt_one_new','sub_one',2100,'pending'),
          ('evt_two','sub_two',3100,'pending');

  INSERT INTO billing_stripe_reconciliation_jobs(
    event_id,processing_state,attempt_count,next_attempt_at_ms,lease_token_sha256,
    lease_expires_at_ms,completed_at_ms,last_error_code,claim_decision_id
  ) VALUES
    ('evt_one_old','dead_letter',2,1300,NULL,NULL,1400,'stripe_reconciliation_failed',NULL),
    ('evt_one_new','processing',1,2200,'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      999999999999,NULL,NULL,NULL),
    ('evt_two','succeeded',1,3200,NULL,NULL,3300,NULL,77);

  INSERT INTO billing_stripe_reconciliation_attempts(
    event_id,attempt_number,lease_started_at_ms,lease_expires_at_ms,finished_at_ms,outcome,error_code
  ) VALUES
    ('evt_one_old',1,1110,1210,1200,'retry','stripe_provider_timeout'),
    ('evt_one_old',2,1210,1310,1400,'dead_letter','stripe_reconciliation_failed'),
    ('evt_one_new',1,2110,999999999999,NULL,NULL,NULL),
    ('evt_two',1,3110,3210,3300,'succeeded',NULL);

  INSERT INTO billing_stripe_reconciliation_recoveries(
    event_id,attempt_number,actor_user_id,evidence_reference,requested_at_ms,
    completed_at_ms,outcome,error_code,claim_decision_id
  ) VALUES(
    'evt_one_old',2,10,'INC-PRIVATE-CUSTOMER-TICKET',1450,1460,
    'dead_letter','stripe_reconciliation_failed',NULL
  );
`);

const repository = createSqliteStripeReconciliationEvidenceExportRepository(db);
const report = repository.exportTenantEvidence({ organizationId: 1, limit: 10 });

assert.equal(report.schemaVersion, 'scopeweave.stripe-reconciliation-evidence/v1');
assert.equal(report.organizationId, 1);
assert.equal(report.events.length, 2, 'only the requested tenant evidence is exported');
assert.deepEqual(report.events.map((event) => event.eventId), ['evt_one_new', 'evt_one_old']);
assert.equal(JSON.stringify(report).includes('evt_two'), false, 'foreign tenant identities never enter the export');
assert.equal(JSON.stringify(report).includes('cus_two'), false, 'foreign customer identities never enter the export');
assert.equal(
  JSON.stringify(report).includes('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'),
  false,
  'active lease hashes never enter customer-facing evidence exports',
);
assert.equal(
  JSON.stringify(report).includes('INC-PRIVATE-CUSTOMER-TICKET'),
  false,
  'free-form operator evidence text is not copied into the export',
);

const newest = report.events[0];
assert.deepEqual(newest, {
  eventId: 'evt_one_new',
  subscriptionId: 'sub_one',
  eventType: 'invoice.paid',
  providerCreatedAtSec: 1787000100,
  payloadSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  firstReceivedAtMs: 2000,
  queuedAtMs: 2100,
  processingState: 'processing',
  attemptCount: 1,
  nextAttemptAtMs: 2200,
  completedAtMs: null,
  lastErrorCode: null,
  claimDecisionId: null,
  attempts: [{
    attemptNumber: 1,
    leaseStartedAtMs: 2110,
    leaseExpiresAtMs: 999999999999,
    finishedAtMs: null,
    outcome: null,
    errorCode: null,
  }],
  recoveries: [],
});

const older = report.events[1];
assert.equal(older.recoveries.length, 1);
assert.deepEqual(older.recoveries[0], {
  recoveryId: 1,
  attemptNumber: 2,
  actorUserId: 10,
  evidenceReferenceSha256: createHash('sha256')
    .update('INC-PRIVATE-CUSTOMER-TICKET', 'utf8')
    .digest('hex'),
  requestedAtMs: 1450,
  completedAtMs: 1460,
  outcome: 'dead_letter',
  errorCode: 'stripe_reconciliation_failed',
  claimDecisionId: null,
});

assert.deepEqual(
  repository.exportTenantEvidence({ organizationId: 1, limit: 1 }).events.map((event) => event.eventId),
  ['evt_one_new'],
  'event count is bounded before nested history is materialized',
);
assert.deepEqual(
  repository.exportTenantEvidence({ organizationId: 999, limit: 10 }),
  {
    schemaVersion: 'scopeweave.stripe-reconciliation-evidence/v1',
    organizationId: 999,
    events: [],
  },
  'an unknown tenant does not disclose whether another tenant has billing evidence',
);

for (const input of [
  { organizationId: 0, limit: 10 },
  { organizationId: 1, limit: 0 },
  { organizationId: 1, limit: 101 },
  { organizationId: 1, limit: 1.5 },
]) {
  assert.throws(
    () => repository.exportTenantEvidence(input),
    (error) => error instanceof StripeReconciliationEvidenceExportError
      && error.code === 'stripe_reconciliation_evidence_export_invalid',
  );
}

// Export is an audit boundary over persisted state, so it must not serialize a
// contradictory terminal job as authoritative evidence even if a damaged restore or
// manually altered database bypassed the worker table's normal CHECK constraints.
db.exec(`
  UPDATE billing_stripe_reconciliation_jobs
     SET processing_state = 'succeeded', completed_at_ms = NULL,
         last_error_code = NULL, claim_decision_id = 42
   WHERE event_id = 'evt_one_new';
`);
assert.throws(
  () => repository.exportTenantEvidence({ organizationId: 1, limit: 1 }),
  (error) => error instanceof StripeReconciliationEvidenceExportError
    && error.code === 'stripe_reconciliation_evidence_export_invalid'
    && error.status === 500,
  'contradictory persisted job state fails closed instead of becoming audit evidence',
);
db.exec(`
  UPDATE billing_stripe_reconciliation_jobs
     SET processing_state = 'processing', completed_at_ms = NULL,
         last_error_code = NULL, claim_decision_id = NULL
   WHERE event_id = 'evt_one_new';
`);

// The production worker constrains lease expiry and completion to occur no earlier
// than lease start. A damaged restore that bypasses those CHECKs must not become a
// plausible-looking audit timeline.
db.exec(`
  UPDATE billing_stripe_reconciliation_attempts
     SET lease_expires_at_ms = 2100
   WHERE event_id = 'evt_one_new' AND attempt_number = 1;
`);
assert.throws(
  () => repository.exportTenantEvidence({ organizationId: 1, limit: 1 }),
  (error) => error instanceof StripeReconciliationEvidenceExportError
    && error.status === 500,
  'attempt lease expiry before lease start fails closed',
);
db.exec(`
  UPDATE billing_stripe_reconciliation_attempts
     SET lease_expires_at_ms = 999999999999
   WHERE event_id = 'evt_one_new' AND attempt_number = 1;
  UPDATE billing_stripe_reconciliation_attempts
     SET finished_at_ms = 1100
   WHERE event_id = 'evt_one_old' AND attempt_number = 1;
`);
assert.throws(
  () => repository.exportTenantEvidence({ organizationId: 1, limit: 10 }),
  (error) => error instanceof StripeReconciliationEvidenceExportError
    && error.status === 500,
  'attempt completion before lease start fails closed',
);
db.exec(`
  UPDATE billing_stripe_reconciliation_attempts
     SET finished_at_ms = 1200
   WHERE event_id = 'evt_one_old' AND attempt_number = 1;
`);

// Recovery completion chronology is persisted evidence too; a damaged restore that
// predates completion before the operator request must fail closed.
db.exec(`
  UPDATE billing_stripe_reconciliation_recoveries
     SET completed_at_ms = 1400
   WHERE event_id = 'evt_one_old' AND recovery_id = 1;
`);
assert.throws(
  () => repository.exportTenantEvidence({ organizationId: 1, limit: 10 }),
  (error) => error instanceof StripeReconciliationEvidenceExportError
    && error.status === 500,
  'recovery completion before request fails closed',
);
db.exec(`
  UPDATE billing_stripe_reconciliation_recoveries
     SET completed_at_ms = 1460
   WHERE event_id = 'evt_one_old' AND recovery_id = 1;
`);

// Production recovery rows are composite-FK-bound to the exact worker attempt. A
// damaged restore must not be able to make one recovery appear to authorize an
// attempt that does not exist in the exported event history.
db.exec(`
  UPDATE billing_stripe_reconciliation_recoveries
     SET attempt_number = 99
   WHERE event_id = 'evt_one_old' AND recovery_id = 1;
`);
assert.throws(
  () => repository.exportTenantEvidence({ organizationId: 1, limit: 10 }),
  (error) => error instanceof StripeReconciliationEvidenceExportError
    && error.status === 500,
  'recovery referencing a missing attempt fails closed',
);
db.exec(`
  UPDATE billing_stripe_reconciliation_recoveries
     SET attempt_number = 2
   WHERE event_id = 'evt_one_old' AND recovery_id = 1;
`);

// attempt_count is the worker's durable count of append-only attempts. If a damaged
// restore loses an attempt row, the export must not present a plausible but incomplete
// audit history merely because the surviving attempt numbers are individually valid.
db.exec(`
  DELETE FROM billing_stripe_reconciliation_attempts
   WHERE event_id = 'evt_one_old' AND attempt_number = 1;
`);
assert.throws(
  () => repository.exportTenantEvidence({ organizationId: 1, limit: 10 }),
  (error) => error instanceof StripeReconciliationEvidenceExportError
    && error.status === 500,
  'missing append-only attempt history fails closed instead of producing incomplete audit evidence',
);
db.exec(`
  INSERT INTO billing_stripe_reconciliation_attempts(
    event_id,attempt_number,lease_started_at_ms,lease_expires_at_ms,finished_at_ms,outcome,error_code
  ) VALUES('evt_one_old',1,1110,1210,1200,'retry','stripe_provider_timeout');
`);

// A single selected event with more nested rows than the hard response budget must
// fail closed instead of allocating an arbitrarily large JSON evidence document.
db.exec(`
  DELETE FROM billing_stripe_reconciliation_attempts WHERE event_id = 'evt_one_new';
  WITH RECURSIVE sequence(value) AS (
    VALUES(1)
    UNION ALL
    SELECT value + 1 FROM sequence WHERE value < 1001
  )
  INSERT INTO billing_stripe_reconciliation_attempts(
    event_id,attempt_number,lease_started_at_ms,lease_expires_at_ms,finished_at_ms,outcome,error_code
  )
  SELECT 'evt_one_new', value, 5000 + value, 6000 + value, 6000 + value, 'retry', 'stripe_provider_timeout'
    FROM sequence;
`);
assert.throws(
  () => repository.exportTenantEvidence({ organizationId: 1, limit: 1 }),
  (error) => error instanceof StripeReconciliationEvidenceExportError
    && error.code === 'stripe_reconciliation_evidence_export_too_large'
    && error.status === 413,
  'oversized nested evidence fails closed with a stable bounded error',
);

db.close();