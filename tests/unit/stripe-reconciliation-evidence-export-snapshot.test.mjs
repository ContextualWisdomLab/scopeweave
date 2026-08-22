import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createSqliteStripeReconciliationEvidenceExportRepository,
} from '../../server/stripe_reconciliation_evidence_export.mjs';

const tempDirectory = mkdtempSync(join(tmpdir(), 'scopeweave-reconciliation-evidence-'));
const databasePath = join(tempDirectory, 'snapshot.sqlite');
let bootstrap;
let reader;
let writer;

try {
  bootstrap = new DatabaseSync(databasePath);
  bootstrap.exec(`
    PRAGMA journal_mode = WAL;
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

    INSERT INTO orgs(id, name) VALUES(1, 'Tenant Snapshot');
    INSERT INTO billing_stripe_customers(customer_id, organization_id, first_observed_at_ms)
      VALUES('cus_snapshot', 1, 100);
    INSERT INTO billing_stripe_subscriptions(subscription_id, customer_id, first_observed_at_ms)
      VALUES('sub_snapshot', 'cus_snapshot', 100);
    INSERT INTO billing_stripe_webhook_events(
      event_id, provider_created_at_sec, event_type, object_id, object_type,
      api_version, request_id, payload_sha256, first_received_at_ms
    ) VALUES(
      'evt_snapshot', 1787000000, 'invoice.paid', 'in_snapshot', 'invoice',
      '2025-03-31.basil', 'req_snapshot',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1000
    );
    INSERT INTO billing_stripe_reconciliation_triggers(
      event_id, subscription_id, queued_at_ms, processing_state
    ) VALUES('evt_snapshot', 'sub_snapshot', 1100, 'pending');
    INSERT INTO billing_stripe_reconciliation_jobs(
      event_id, processing_state, attempt_count, next_attempt_at_ms,
      lease_token_sha256, lease_expires_at_ms, completed_at_ms,
      last_error_code, claim_decision_id
    ) VALUES('evt_snapshot', 'pending', 0, 1200, NULL, NULL, NULL, NULL, NULL);
  `);
  bootstrap.close();
  bootstrap = null;

  reader = new DatabaseSync(databasePath);
  writer = new DatabaseSync(databasePath);
  reader.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;');
  writer.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;');

  let writerCommitted = false;
  const databaseWithConcurrentWriter = {
    exec(sql) {
      return reader.exec(sql);
    },
    prepare(sql) {
      const statement = reader.prepare(sql);
      if (!sql.includes('FROM billing_stripe_reconciliation_attempts')) return statement;
      return {
        all(...parameters) {
          if (!writerCommitted) {
            writer.exec(`
              BEGIN IMMEDIATE;
              UPDATE billing_stripe_reconciliation_jobs
                 SET processing_state = 'processing',
                     attempt_count = 1,
                     lease_token_sha256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                     lease_expires_at_ms = 5000
               WHERE event_id = 'evt_snapshot';
              INSERT INTO billing_stripe_reconciliation_attempts(
                event_id, attempt_number, lease_started_at_ms, lease_expires_at_ms,
                finished_at_ms, outcome, error_code
              ) VALUES('evt_snapshot', 1, 4000, 5000, NULL, NULL, NULL);
              COMMIT;
            `);
            writerCommitted = true;
          }
          return statement.all(...parameters);
        },
      };
    },
  };

  const repository = createSqliteStripeReconciliationEvidenceExportRepository(
    databaseWithConcurrentWriter,
  );
  const firstReport = repository.exportTenantEvidence({ organizationId: 1, limit: 10 });

  assert.equal(writerCommitted, true, 'the concurrent reconciliation write committed during export');
  assert.deepEqual(
    firstReport.events.map((event) => ({
      eventId: event.eventId,
      processingState: event.processingState,
      attemptCount: event.attemptCount,
      attempts: event.attempts.length,
    })),
    [{ eventId: 'evt_snapshot', processingState: 'pending', attemptCount: 0, attempts: 0 }],
    'one evidence document must come from one SQLite read snapshot even while a writer commits',
  );

  const secondReport = repository.exportTenantEvidence({ organizationId: 1, limit: 10 });
  assert.deepEqual(
    secondReport.events.map((event) => ({
      eventId: event.eventId,
      processingState: event.processingState,
      attemptCount: event.attemptCount,
      attempts: event.attempts.length,
    })),
    [{ eventId: 'evt_snapshot', processingState: 'processing', attemptCount: 1, attempts: 1 }],
    'a later export observes the committed reconciliation state after the snapshot is released',
  );
} finally {
  try { writer?.close(); } catch {}
  try { reader?.close(); } catch {}
  try { bootstrap?.close(); } catch {}
  rmSync(tempDirectory, { recursive: true, force: true });
}
