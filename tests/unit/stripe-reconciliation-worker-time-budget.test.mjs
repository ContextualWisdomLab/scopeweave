import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { installStripeSubscriptionObservationSchema } from '../../server/stripe_subscription_observation_ledger.mjs';
import { installStripeWebhookEventSchema } from '../../server/stripe_webhook_event_ledger.mjs';
import { installStripeWebhookReconciliationQueueSchema } from '../../server/stripe_webhook_reconciliation_queue.mjs';
import {
  createSqliteStripeReconciliationWorkerRepository,
  installStripeReconciliationWorkerSchema,
  runNextStripeReconciliationJob,
} from '../../server/stripe_reconciliation_worker.mjs';

function databaseWithReadyTrigger() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`
    CREATE TABLE orgs (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free'
    );
  `);
  installStripeWebhookEventSchema(database);
  installStripeSubscriptionObservationSchema(database);
  installStripeWebhookReconciliationQueueSchema(database);
  installStripeReconciliationWorkerSchema(database);
  database.prepare('INSERT INTO orgs(id,name,plan) VALUES(?,?,?)').run(7, 'Lease Budget Org', 'free');
  database.prepare(`
    INSERT INTO billing_stripe_customers(customer_id, organization_id, first_observed_at_ms)
    VALUES(?,?,?)
  `).run('cus_lease_budget', 7, 1_000);
  database.prepare(`
    INSERT INTO billing_stripe_subscriptions(subscription_id, customer_id, first_observed_at_ms)
    VALUES(?,?,?)
  `).run('sub_lease_budget', 'cus_lease_budget', 1_000);
  database.prepare(`
    INSERT INTO billing_stripe_webhook_events(
      event_id, provider_created_at_sec, event_type, object_id, object_type,
      api_version, request_id, payload_sha256, first_received_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    'evt_lease_budget',
    1_787_000_000,
    'customer.subscription.updated',
    'sub_lease_budget',
    'subscription',
    '2025-03-31.basil',
    null,
    'b'.repeat(64),
    1_000,
  );
  database.prepare(`
    INSERT INTO billing_stripe_reconciliation_triggers(
      event_id, subscription_id, queued_at_ms, processing_state
    ) VALUES(?,?,?,'pending')
  `).run('evt_lease_budget', 'sub_lease_budget', 1_000);
  return database;
}

test('default worker lease exceeds the two sequential 15-second authoritative provider budgets', () => {
  const database = databaseWithReadyTrigger();
  const nowMs = 2_000;
  const repository = createSqliteStripeReconciliationWorkerRepository(database, {
    now: () => nowMs,
    randomToken: () => 'lease_token_budget_1234567890',
  });

  const claim = repository.claimNext();
  assert.ok(claim);
  assert.ok(
    claim.leaseExpiresAtMs - nowMs > 30_000,
    'default lease must leave completion margin beyond Subscription + Invoice timeout budgets',
  );
});

test('provider success followed by uncertain worker completion never starts a failure transition', async () => {
  let failureTransitions = 0;
  const repository = {
    claimNext() {
      return {
        eventId: 'evt_worker_completion_uncertain',
        subscriptionId: 'sub_worker_completion_uncertain',
        leaseToken: 'lease_token_completion_123456',
      };
    },
    resolveOrganizationId() {
      return 7;
    },
    complete() {
      throw new Error('injected completion state uncertainty');
    },
    fail() {
      failureTransitions += 1;
      return {
        status: 'retry',
        eventId: 'evt_worker_completion_uncertain',
        errorCode: 'stripe_reconciliation_failed',
        nextAttemptAtMs: 9_000,
      };
    },
  };

  await assert.rejects(
    runNextStripeReconciliationJob({
      repository,
      reconcile: async () => ({
        organizationId: 7,
        subscriptionId: 'sub_worker_completion_uncertain',
        claimDecisionId: 91,
      }),
    }),
    (error) => error?.code === 'stripe_reconciliation_worker_state_uncertain'
      && error.status === 500,
  );
  assert.equal(failureTransitions, 0);
});
