import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { installStripeSubscriptionObservationSchema } from '../../server/stripe_subscription_observation_ledger.mjs';
import { installStripeWebhookEventSchema } from '../../server/stripe_webhook_event_ledger.mjs';
import { installStripeWebhookReconciliationQueueSchema } from '../../server/stripe_webhook_reconciliation_queue.mjs';
import {
  StripeReconciliationWorkerError,
  createSqliteStripeReconciliationWorkerRepository,
  installStripeReconciliationWorkerSchema,
  runNextStripeReconciliationJob,
} from '../../server/stripe_reconciliation_worker.mjs';

function createWorkerDatabase() {
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
  return database;
}

function seedTrigger(database, {
  eventId = 'evt_worker',
  subscriptionId = 'sub_worker',
  organizationId = 7,
  withAuthority = true,
} = {}) {
  database.prepare('INSERT INTO orgs(id, name, plan) VALUES(?,?,?)')
    .run(organizationId, 'Worker Org', 'free');
  if (withAuthority) {
    database.prepare(`
      INSERT INTO billing_stripe_customers(customer_id, organization_id, first_observed_at_ms)
      VALUES(?,?,?)
    `).run('cus_worker', organizationId, 1_000);
    database.prepare(`
      INSERT INTO billing_stripe_subscriptions(subscription_id, customer_id, first_observed_at_ms)
      VALUES(?,?,?)
    `).run(subscriptionId, 'cus_worker', 1_000);
  }
  database.prepare(`
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
    'a'.repeat(64),
    1_000,
  );
  database.prepare(`
    INSERT INTO billing_stripe_reconciliation_triggers(
      event_id, subscription_id, queued_at_ms, processing_state
    ) VALUES(?,?,?,'pending')
  `).run(eventId, subscriptionId, 1_000);
}

function sequentialTokens() {
  let index = 0;
  return () => `lease_token_${String(++index).padStart(16, '0')}`;
}

test('worker claims one durable trigger, uses server-owned tenant authority, and records successful completion', async () => {
  const database = createWorkerDatabase();
  seedTrigger(database);
  let nowMs = 2_000;
  const repository = createSqliteStripeReconciliationWorkerRepository(database, {
    now: () => nowMs,
    randomToken: sequentialTokens(),
    leaseMs: 30_000,
  });
  const calls = [];

  const result = await runNextStripeReconciliationJob({
    repository,
    reconcile: async (input) => {
      calls.push(input);
      return {
        organizationId: input.organizationId,
        subscriptionId: input.subscriptionId,
        subscriptionObservationId: 11,
        invoiceObservationId: 12,
        claimDecisionId: 13,
      };
    },
    reconciliationDependencies: { secretKey: 'sk_test_server_owned' },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.eventId, 'evt_worker');
  assert.equal(result.subscriptionId, 'sub_worker');
  assert.equal(result.organizationId, 7);
  assert.equal(result.claimDecisionId, 13);
  assert.deepEqual(calls, [{
    organizationId: 7,
    subscriptionId: 'sub_worker',
    sourceEventId: 'evt_worker',
    secretKey: 'sk_test_server_owned',
  }]);

  const job = database.prepare(`
    SELECT processing_state, attempt_count, claim_decision_id, lease_token_sha256,
           lease_expires_at_ms, completed_at_ms, last_error_code
      FROM billing_stripe_reconciliation_jobs WHERE event_id = ?
  `).get('evt_worker');
  assert.deepEqual({ ...job }, {
    processing_state: 'succeeded',
    attempt_count: 1,
    claim_decision_id: 13,
    lease_token_sha256: null,
    lease_expires_at_ms: null,
    completed_at_ms: nowMs,
    last_error_code: null,
  });

  const attempt = database.prepare(`
    SELECT attempt_number, outcome, error_code
      FROM billing_stripe_reconciliation_attempts WHERE event_id = ?
  `).get('evt_worker');
  assert.deepEqual({ ...attempt }, {
    attempt_number: 1,
    outcome: 'succeeded',
    error_code: null,
  });
  assert.equal(repository.claimNext(), null, 'completed work is never claimed again');
});

test('leases prevent concurrent duplicate processing and stale workers cannot complete reclaimed work', () => {
  const database = createWorkerDatabase();
  seedTrigger(database);
  let nowMs = 5_000;
  const repository = createSqliteStripeReconciliationWorkerRepository(database, {
    now: () => nowMs,
    randomToken: sequentialTokens(),
    leaseMs: 100,
  });

  const first = repository.claimNext();
  assert.equal(first.attemptNumber, 1);
  assert.equal(repository.claimNext(), null, 'an unexpired lease excludes another worker');

  nowMs = 5_101;
  const second = repository.claimNext();
  assert.equal(second.attemptNumber, 2);
  assert.notEqual(second.leaseToken, first.leaseToken);

  assert.throws(
    () => repository.complete({
      eventId: first.eventId,
      leaseToken: first.leaseToken,
      claimDecisionId: 41,
    }),
    (error) => error instanceof StripeReconciliationWorkerError
      && error.code === 'stripe_reconciliation_lease_stale',
  );

  repository.complete({
    eventId: second.eventId,
    leaseToken: second.leaseToken,
    claimDecisionId: 42,
  });
  const attempts = database.prepare(`
    SELECT attempt_number, outcome, error_code
      FROM billing_stripe_reconciliation_attempts
     WHERE event_id = ? ORDER BY attempt_number
  `).all('evt_worker').map((row) => ({ ...row }));
  assert.deepEqual(attempts, [
    {
      attempt_number: 1,
      outcome: 'retry',
      error_code: 'stripe_reconciliation_lease_expired',
    },
    {
      attempt_number: 2,
      outcome: 'succeeded',
      error_code: null,
    },
  ]);
});

test('worker failures back off, dead-letter at the bounded attempt budget, and never persist arbitrary provider text', async () => {
  const database = createWorkerDatabase();
  seedTrigger(database);
  let nowMs = 10_000;
  const repository = createSqliteStripeReconciliationWorkerRepository(database, {
    now: () => nowMs,
    randomToken: sequentialTokens(),
    leaseMs: 1_000,
    maxAttempts: 2,
    baseBackoffMs: 50,
    maxBackoffMs: 500,
  });
  const unsafeMessage = 'provider failed with sk_live_should_never_be_persisted';

  const first = await runNextStripeReconciliationJob({
    repository,
    reconcile: async () => {
      throw new Error(unsafeMessage);
    },
  });
  assert.equal(first.status, 'retry');
  assert.equal(first.errorCode, 'stripe_reconciliation_failed');
  assert.equal(repository.claimNext(), null, 'backoff prevents an immediate hot loop');

  nowMs += 50;
  const second = await runNextStripeReconciliationJob({
    repository,
    reconcile: async () => {
      throw new Error(unsafeMessage);
    },
  });
  assert.equal(second.status, 'dead_letter');
  assert.equal(second.errorCode, 'stripe_reconciliation_failed');

  const persisted = database.prepare(`
    SELECT processing_state, attempt_count, last_error_code
      FROM billing_stripe_reconciliation_jobs WHERE event_id = ?
  `).get('evt_worker');
  assert.deepEqual({ ...persisted }, {
    processing_state: 'dead_letter',
    attempt_count: 2,
    last_error_code: 'stripe_reconciliation_failed',
  });
  const persistedText = JSON.stringify(database.prepare(`
    SELECT error_code FROM billing_stripe_reconciliation_attempts WHERE event_id = ?
  `).all('evt_worker'));
  assert.equal(persistedText.includes('sk_live'), false);
  assert.equal(repository.claimNext(), null);
});

test('missing tenant identity remains explicit retryable work and never calls the provider reconciliation port', async () => {
  const database = createWorkerDatabase();
  seedTrigger(database, { withAuthority: false });
  let nowMs = 20_000;
  const repository = createSqliteStripeReconciliationWorkerRepository(database, {
    now: () => nowMs,
    randomToken: sequentialTokens(),
    baseBackoffMs: 25,
  });
  let reconcileCalls = 0;

  const result = await runNextStripeReconciliationJob({
    repository,
    reconcile: async () => {
      reconcileCalls += 1;
      throw new Error('must not run');
    },
  });

  assert.equal(reconcileCalls, 0);
  assert.equal(result.status, 'retry');
  assert.equal(result.errorCode, 'stripe_reconciliation_authority_missing');
  const job = database.prepare(`
    SELECT processing_state, next_attempt_at_ms, last_error_code
      FROM billing_stripe_reconciliation_jobs WHERE event_id = ?
  `).get('evt_worker');
  assert.equal(job.processing_state, 'pending');
  assert.equal(job.next_attempt_at_ms, nowMs + 25);
  assert.equal(job.last_error_code, 'stripe_reconciliation_authority_missing');
});

test('dependency options cannot override server-owned tenant, Subscription, or verified Event authority', async () => {
  const database = createWorkerDatabase();
  seedTrigger(database, {
    eventId: 'evt_authority_worker',
    subscriptionId: 'sub_authority_worker',
    organizationId: 17,
  });
  const repository = createSqliteStripeReconciliationWorkerRepository(database, {
    now: () => 30_000,
    randomToken: sequentialTokens(),
  });
  const calls = [];

  const result = await runNextStripeReconciliationJob({
    repository,
    reconcile: async (input) => {
      calls.push(input);
      return {
        organizationId: input.organizationId,
        subscriptionId: input.subscriptionId,
        claimDecisionId: 71,
      };
    },
    reconciliationDependencies: {
      organizationId: 999,
      subscriptionId: 'sub_foreign_override',
      sourceEventId: 'evt_foreign_override',
      secretKey: 'sk_test_server_owned',
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.organizationId, 17);
  assert.equal(result.subscriptionId, 'sub_authority_worker');
  assert.deepEqual(calls, [{
    organizationId: 17,
    subscriptionId: 'sub_authority_worker',
    sourceEventId: 'evt_authority_worker',
    secretKey: 'sk_test_server_owned',
  }]);
});
