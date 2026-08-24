import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  StripeReconciliationEvidenceExportError,
  createSqliteStripeReconciliationEvidenceExportRepository,
} from '../../server/stripe_reconciliation_evidence_export.mjs';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE billing_stripe_customers (
    customer_id TEXT PRIMARY KEY,
    organization_id INTEGER NOT NULL
  );
  CREATE TABLE billing_stripe_subscriptions (
    subscription_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL
  );
  CREATE TABLE billing_stripe_webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    provider_created_at_sec INTEGER NOT NULL,
    payload_sha256 TEXT NOT NULL,
    first_received_at_ms INTEGER NOT NULL
  );
  CREATE TABLE billing_stripe_reconciliation_triggers (
    event_id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    queued_at_ms INTEGER NOT NULL
  );
  CREATE TABLE billing_stripe_reconciliation_jobs (
    event_id TEXT PRIMARY KEY,
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
    event_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    lease_started_at_ms INTEGER NOT NULL,
    lease_expires_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    outcome TEXT,
    error_code TEXT
  );
  CREATE TABLE billing_stripe_reconciliation_recoveries (
    recovery_id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    actor_user_id INTEGER NOT NULL,
    evidence_reference TEXT NOT NULL,
    requested_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    outcome TEXT,
    error_code TEXT,
    claim_decision_id INTEGER
  );

  INSERT INTO billing_stripe_customers(customer_id,organization_id)
    VALUES('cus_one',1);
  INSERT INTO billing_stripe_subscriptions(subscription_id,customer_id)
    VALUES('sub_one','cus_one');
  INSERT INTO billing_stripe_webhook_events(
    event_id,event_type,provider_created_at_sec,payload_sha256,first_received_at_ms
  ) VALUES(
    'evt_one','invoice.paid',1787000100,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1000
  );
  INSERT INTO billing_stripe_reconciliation_triggers(event_id,subscription_id,queued_at_ms)
    VALUES('evt_one','sub_one',1100);
  INSERT INTO billing_stripe_reconciliation_jobs(
    event_id,processing_state,attempt_count,next_attempt_at_ms,lease_token_sha256,
    lease_expires_at_ms,completed_at_ms,last_error_code,claim_decision_id
  ) VALUES(
    'evt_one','processing',1,1200,
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    5000,NULL,NULL,NULL
  );
  INSERT INTO billing_stripe_reconciliation_attempts(
    event_id,attempt_number,lease_started_at_ms,lease_expires_at_ms,finished_at_ms,outcome,error_code
  ) VALUES('evt_one',1,4000,5000,NULL,NULL,NULL);
`);

const repository = createSqliteStripeReconciliationEvidenceExportRepository(db);
const valid = repository.exportTenantEvidence({ organizationId: 1, limit: 1 });
assert.equal(valid.events.length, 1);
assert.equal(
  JSON.stringify(valid).includes('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  false,
  'active lease-token hashes remain validation-only and never enter exported evidence',
);

function assertFailsClosed(message) {
  assert.throws(
    () => repository.exportTenantEvidence({ organizationId: 1, limit: 1 }),
    (error) => error instanceof StripeReconciliationEvidenceExportError
      && error.status === 500,
    message,
  );
}

// A processing worker row is authoritative only while it retains the opaque lease
// digest required by the worker schema. A damaged restore must not become plausible
// audit evidence merely because the attempt row is otherwise coherent.
db.exec(`
  UPDATE billing_stripe_reconciliation_jobs
     SET lease_token_sha256 = NULL
   WHERE event_id = 'evt_one';
`);
assertFailsClosed('processing evidence without its active lease digest fails closed');

db.exec(`
  UPDATE billing_stripe_reconciliation_jobs
     SET lease_token_sha256 = 'not-a-sha256'
   WHERE event_id = 'evt_one';
`);
assertFailsClosed('processing evidence with a malformed lease digest fails closed');

db.exec(`
  UPDATE billing_stripe_reconciliation_jobs
     SET lease_token_sha256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
         lease_expires_at_ms = NULL
   WHERE event_id = 'evt_one';
`);
assertFailsClosed('processing evidence without durable lease expiry fails closed');

db.exec(`
  UPDATE billing_stripe_reconciliation_jobs
     SET lease_expires_at_ms = 5001
   WHERE event_id = 'evt_one';
`);
assertFailsClosed('job lease expiry must agree with the exact unfinished attempt');

// Terminal worker state clears active lease material atomically. If damaged state
// retains a lease after success, the evidence exporter must reject that contradiction.
db.exec(`
  UPDATE billing_stripe_reconciliation_attempts
     SET finished_at_ms = 6000, outcome = 'succeeded'
   WHERE event_id = 'evt_one' AND attempt_number = 1;
  UPDATE billing_stripe_reconciliation_jobs
     SET processing_state = 'succeeded', lease_expires_at_ms = 5000,
         completed_at_ms = 6000, claim_decision_id = 77
   WHERE event_id = 'evt_one';
`);
assertFailsClosed('terminal evidence retaining active lease material fails closed');

db.close();
