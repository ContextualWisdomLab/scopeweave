import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { installStripeSubscriptionObservationSchema } from '../../server/stripe_subscription_observation_ledger.mjs';
import { installStripeWebhookEventSchema } from '../../server/stripe_webhook_event_ledger.mjs';
import { installStripeWebhookReconciliationQueueSchema } from '../../server/stripe_webhook_reconciliation_queue.mjs';
import {
  createSqliteStripeReconciliationWorkerRepository,
  installStripeReconciliationWorkerSchema,
} from '../../server/stripe_reconciliation_worker.mjs';
import {
  StripeReconciliationRecoveryError,
  createSqliteStripeReconciliationRecoveryRepository,
  installStripeReconciliationRecoverySchema,
  retryStripeReconciliationDeadLetter,
} from '../../server/stripe_reconciliation_recovery.mjs';

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE NOT NULL
    );
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
  installStripeReconciliationRecoverySchema(database);
  return database;
}

function seedDeadLetter(database, {
  eventId = 'evt_dead_letter',
  subscriptionId = 'sub_dead_letter',
  customerId = 'cus_dead_letter',
  organizationId = 7,
  actorUserId = 11,
  attemptCount = 5,
} = {}) {
  database.prepare('INSERT OR IGNORE INTO users(id,email) VALUES(?,?)')
    .run(actorUserId, `operator-${actorUserId}@scopeweave.test`);
  database.prepare('INSERT OR IGNORE INTO orgs(id,name,plan) VALUES(?,?,?)')
    .run(organizationId, `Org ${organizationId}`, 'free');
  database.prepare(`
    INSERT OR IGNORE INTO billing_stripe_customers(customer_id, organization_id, first_observed_at_ms)
    VALUES(?,?,?)
  `).run(customerId, organizationId, 1_000);
  database.prepare(`
    INSERT OR IGNORE INTO billing_stripe_subscriptions(subscription_id, customer_id, first_observed_at_ms)
    VALUES(?,?,?)
  `).run(subscriptionId, customerId, 1_000);
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
  database.prepare(`
    INSERT INTO billing_stripe_reconciliation_jobs(
      event_id, processing_state, attempt_count, next_attempt_at_ms,
      lease_token_sha256, lease_expires_at_ms, completed_at_ms,
      last_error_code, claim_decision_id
    ) VALUES(?,'dead_letter',?,?,NULL,NULL,?,?,NULL)
  `).run(eventId, attemptCount, 2_000, 2_000, 'stripe_reconciliation_failed');
  database.prepare(`
    INSERT INTO billing_stripe_reconciliation_attempts(
      event_id, attempt_number, lease_started_at_ms, lease_expires_at_ms,
      finished_at_ms, outcome, error_code
    ) VALUES(?,?,?,?,?,'dead_letter','stripe_reconciliation_failed')
  `).run(eventId, attemptCount, 1_900, 2_000, 2_000);
}

function tokenSequence() {
  let index = 0;
  return () => `manual_recovery_token_${String(++index).padStart(8, '0')}`;
}

test('operator recovery lists tenant dead letters, retries one exact event, and is idempotent by evidence reference', async () => {
  const database = createDatabase();
  seedDeadLetter(database);
  let nowMs = 3_000;
  const recoveryRepository = createSqliteStripeReconciliationRecoveryRepository(database, {
    now: () => nowMs,
    randomToken: tokenSequence(),
    leaseMs: 30_000,
  });
  const workerRepository = createSqliteStripeReconciliationWorkerRepository(database, {
    now: () => nowMs,
  });

  assert.deepEqual(recoveryRepository.listDeadLetters({ organizationId: 7 }), [{
    eventId: 'evt_dead_letter',
    subscriptionId: 'sub_dead_letter',
    attemptCount: 5,
    completedAtMs: 2_000,
    lastErrorCode: 'stripe_reconciliation_failed',
  }]);
  assert.deepEqual(recoveryRepository.listDeadLetters({ organizationId: 8 }), []);

  let reconcileCalls = 0;
  const first = await retryStripeReconciliationDeadLetter({
    recoveryRepository,
    workerRepository,
    reconcile: async (input) => {
      reconcileCalls += 1;
      assert.deepEqual(input, {
        organizationId: 7,
        subscriptionId: 'sub_dead_letter',
        sourceEventId: 'evt_dead_letter',
        secretKey: 'server-owned-secret',
      });
      return {
        organizationId: 7,
        subscriptionId: 'sub_dead_letter',
        claimDecisionId: 41,
      };
    },
    reconciliationDependencies: { secretKey: 'server-owned-secret' },
    organizationId: 7,
    eventId: 'evt_dead_letter',
    actorUserId: 11,
    evidenceReference: 'INC-2026-0042',
  });
  assert.deepEqual(first, {
    status: 'succeeded',
    replayed: false,
    recoveryId: 1,
    eventId: 'evt_dead_letter',
    subscriptionId: 'sub_dead_letter',
    attemptNumber: 6,
    claimDecisionId: 41,
  });
  assert.equal(reconcileCalls, 1);
  assert.deepEqual(recoveryRepository.listDeadLetters({ organizationId: 7 }), []);

  const job = database.prepare(`
    SELECT processing_state, attempt_count, claim_decision_id, completed_at_ms, last_error_code
      FROM billing_stripe_reconciliation_jobs WHERE event_id = ?
  `).get('evt_dead_letter');
  assert.deepEqual({ ...job }, {
    processing_state: 'succeeded',
    attempt_count: 6,
    claim_decision_id: 41,
    completed_at_ms: nowMs,
    last_error_code: null,
  });
  const attempts = database.prepare(`
    SELECT attempt_number, outcome, error_code
      FROM billing_stripe_reconciliation_attempts
     WHERE event_id = ? ORDER BY attempt_number
  `).all('evt_dead_letter').map((row) => ({ ...row }));
  assert.deepEqual(attempts, [
    { attempt_number: 5, outcome: 'dead_letter', error_code: 'stripe_reconciliation_failed' },
    { attempt_number: 6, outcome: 'succeeded', error_code: null },
  ]);
  const recovery = database.prepare(`
    SELECT event_id, attempt_number, actor_user_id, evidence_reference, requested_at_ms
      FROM billing_stripe_reconciliation_recoveries WHERE recovery_id = 1
  `).get();
  assert.deepEqual({ ...recovery }, {
    event_id: 'evt_dead_letter',
    attempt_number: 6,
    actor_user_id: 11,
    evidence_reference: 'INC-2026-0042',
    requested_at_ms: nowMs,
  });

  const replay = await retryStripeReconciliationDeadLetter({
    recoveryRepository,
    workerRepository,
    reconcile: async () => {
      reconcileCalls += 1;
      throw new Error('idempotent replay must not call provider reconciliation');
    },
    organizationId: 7,
    eventId: 'evt_dead_letter',
    actorUserId: 11,
    evidenceReference: 'INC-2026-0042',
  });
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(reconcileCalls, 1);

  database.close();
});

test('failed manual recovery returns to dead-letter, suppresses unsafe exception text, and permits a new explicit recovery authority', async () => {
  const database = createDatabase();
  seedDeadLetter(database, { eventId: 'evt_manual_retry', subscriptionId: 'sub_manual_retry' });
  let nowMs = 5_000;
  const recoveryRepository = createSqliteStripeReconciliationRecoveryRepository(database, {
    now: () => nowMs,
    randomToken: tokenSequence(),
    leaseMs: 30_000,
  });
  const workerRepository = createSqliteStripeReconciliationWorkerRepository(database, {
    now: () => nowMs,
  });
  let calls = 0;

  const failure = new Error('provider exposed sk_live_must_not_persist');
  failure.code = 'stripe_provider_temporarily_unavailable';
  const failed = await retryStripeReconciliationDeadLetter({
    recoveryRepository,
    workerRepository,
    reconcile: async () => {
      calls += 1;
      throw failure;
    },
    organizationId: 7,
    eventId: 'evt_manual_retry',
    actorUserId: 11,
    evidenceReference: 'INC-2026-0043-attempt-1',
  });
  assert.deepEqual(failed, {
    status: 'dead_letter',
    replayed: false,
    recoveryId: 1,
    eventId: 'evt_manual_retry',
    subscriptionId: 'sub_manual_retry',
    attemptNumber: 6,
    errorCode: 'stripe_provider_temporarily_unavailable',
  });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(database.prepare(`
    SELECT * FROM billing_stripe_reconciliation_attempts WHERE event_id = ?
  `).all('evt_manual_retry')).includes('sk_live'), false);

  const replay = await retryStripeReconciliationDeadLetter({
    recoveryRepository,
    workerRepository,
    reconcile: async () => {
      calls += 1;
      throw new Error('must not run for the same evidence reference');
    },
    organizationId: 7,
    eventId: 'evt_manual_retry',
    actorUserId: 11,
    evidenceReference: 'INC-2026-0043-attempt-1',
  });
  assert.deepEqual(replay, { ...failed, replayed: true });
  assert.equal(calls, 1);

  nowMs = 6_000;
  const succeeded = await retryStripeReconciliationDeadLetter({
    recoveryRepository,
    workerRepository,
    reconcile: async () => ({
      organizationId: 7,
      subscriptionId: 'sub_manual_retry',
      claimDecisionId: 73,
    }),
    organizationId: 7,
    eventId: 'evt_manual_retry',
    actorUserId: 11,
    evidenceReference: 'INC-2026-0043-attempt-2',
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.attemptNumber, 7);
  assert.equal(succeeded.claimDecisionId, 73);

  database.close();
});

test('tenant isolation, bounded evidence references, in-progress replay, and transactional audit rollback fail closed', () => {
  const database = createDatabase();
  seedDeadLetter(database, { eventId: 'evt_recovery_guard', subscriptionId: 'sub_recovery_guard' });
  database.prepare('INSERT INTO orgs(id,name,plan) VALUES(?,?,?)').run(8, 'Foreign Org', 'free');
  database.prepare('INSERT INTO users(id,email) VALUES(?,?)').run(12, 'foreign-operator@scopeweave.test');
  let nowMs = 7_000;
  const recoveryRepository = createSqliteStripeReconciliationRecoveryRepository(database, {
    now: () => nowMs,
    randomToken: tokenSequence(),
    leaseMs: 30_000,
  });
  const workerRepository = createSqliteStripeReconciliationWorkerRepository(database, {
    now: () => nowMs,
  });

  assert.throws(
    () => recoveryRepository.claimDeadLetterRecovery({
      organizationId: 8,
      eventId: 'evt_recovery_guard',
      actorUserId: 12,
      evidenceReference: 'INC-foreign',
    }),
    (error) => error instanceof StripeReconciliationRecoveryError
      && error.code === 'stripe_reconciliation_dead_letter_not_found'
      && error.status === 404,
  );
  for (const evidenceReference of ['', '   ', 'bad\nreference', 'x'.repeat(257), null]) {
    assert.throws(
      () => recoveryRepository.claimDeadLetterRecovery({
        organizationId: 7,
        eventId: 'evt_recovery_guard',
        actorUserId: 11,
        evidenceReference,
      }),
      (error) => error instanceof StripeReconciliationRecoveryError
        && error.code === 'stripe_reconciliation_recovery_invalid',
    );
  }
  assert.throws(
    () => recoveryRepository.listDeadLetters({ organizationId: 7, limit: 101 }),
    (error) => error instanceof StripeReconciliationRecoveryError
      && error.code === 'stripe_reconciliation_recovery_invalid',
  );

  const claimed = recoveryRepository.claimDeadLetterRecovery({
    organizationId: 7,
    eventId: 'evt_recovery_guard',
    actorUserId: 11,
    evidenceReference: 'INC-in-progress',
  });
  assert.equal(claimed.status, 'processing');
  assert.equal(claimed.replayed, false);
  const replay = recoveryRepository.claimDeadLetterRecovery({
    organizationId: 7,
    eventId: 'evt_recovery_guard',
    actorUserId: 11,
    evidenceReference: 'INC-in-progress',
  });
  assert.deepEqual(replay, {
    status: 'processing',
    replayed: true,
    recoveryId: claimed.recoveryId,
    eventId: claimed.eventId,
    subscriptionId: claimed.subscriptionId,
    attemptNumber: claimed.attemptNumber,
  });
  workerRepository.fail({
    eventId: claimed.eventId,
    leaseToken: claimed.leaseToken,
    errorCode: 'stripe_reconciliation_operator_cancelled',
  });

  seedDeadLetter(database, {
    eventId: 'evt_recovery_rollback',
    subscriptionId: 'sub_recovery_rollback',
    customerId: 'cus_recovery_rollback',
  });
  database.exec(`
    CREATE TRIGGER fail_recovery_audit
    BEFORE INSERT ON billing_stripe_reconciliation_recoveries
    BEGIN
      SELECT RAISE(ABORT, 'injected recovery audit failure');
    END;
  `);
  assert.throws(() => recoveryRepository.claimDeadLetterRecovery({
    organizationId: 7,
    eventId: 'evt_recovery_rollback',
    actorUserId: 11,
    evidenceReference: 'INC-rollback',
  }), /injected recovery audit failure/);
  const rolledBackJob = database.prepare(`
    SELECT processing_state, attempt_count, completed_at_ms, last_error_code
      FROM billing_stripe_reconciliation_jobs WHERE event_id = ?
  `).get('evt_recovery_rollback');
  assert.deepEqual({ ...rolledBackJob }, {
    processing_state: 'dead_letter',
    attempt_count: 5,
    completed_at_ms: 2_000,
    last_error_code: 'stripe_reconciliation_failed',
  });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM billing_stripe_reconciliation_attempts
     WHERE event_id = ? AND attempt_number = 6
  `).get('evt_recovery_rollback').count, 0);

  database.close();
});

test('expired manual recovery lease self-reaps to dead-letter and permits explicit retry without a scheduler', () => {
  const database = createDatabase();
  seedDeadLetter(database, {
    eventId: 'evt_recovery_expired',
    subscriptionId: 'sub_recovery_expired',
    customerId: 'cus_recovery_expired',
  });
  let nowMs = 9_000;
  const recoveryRepository = createSqliteStripeReconciliationRecoveryRepository(database, {
    now: () => nowMs,
    randomToken: tokenSequence(),
    leaseMs: 100,
  });

  const claimed = recoveryRepository.claimDeadLetterRecovery({
    organizationId: 7,
    eventId: 'evt_recovery_expired',
    actorUserId: 11,
    evidenceReference: 'INC-expired-1',
  });
  assert.equal(claimed.status, 'processing');
  assert.equal(claimed.attemptNumber, 6);

  nowMs = claimed.leaseExpiresAtMs;
  const expiredReplay = recoveryRepository.claimDeadLetterRecovery({
    organizationId: 7,
    eventId: 'evt_recovery_expired',
    actorUserId: 11,
    evidenceReference: 'INC-expired-1',
  });
  assert.deepEqual(expiredReplay, {
    status: 'dead_letter',
    replayed: true,
    recoveryId: claimed.recoveryId,
    eventId: claimed.eventId,
    subscriptionId: claimed.subscriptionId,
    attemptNumber: claimed.attemptNumber,
    errorCode: 'stripe_reconciliation_lease_expired',
  });

  const job = database.prepare(`
    SELECT processing_state, attempt_count, lease_token_sha256, lease_expires_at_ms,
           completed_at_ms, last_error_code
      FROM billing_stripe_reconciliation_jobs WHERE event_id = ?
  `).get('evt_recovery_expired');
  assert.deepEqual({ ...job }, {
    processing_state: 'dead_letter',
    attempt_count: 6,
    lease_token_sha256: null,
    lease_expires_at_ms: null,
    completed_at_ms: nowMs,
    last_error_code: 'stripe_reconciliation_lease_expired',
  });
  const attempt = database.prepare(`
    SELECT finished_at_ms, outcome, error_code
      FROM billing_stripe_reconciliation_attempts
     WHERE event_id = ? AND attempt_number = 6
  `).get('evt_recovery_expired');
  assert.deepEqual({ ...attempt }, {
    finished_at_ms: nowMs,
    outcome: 'dead_letter',
    error_code: 'stripe_reconciliation_lease_expired',
  });
  const recovery = database.prepare(`
    SELECT completed_at_ms, outcome, error_code, claim_decision_id
      FROM billing_stripe_reconciliation_recoveries
     WHERE recovery_id = ?
  `).get(claimed.recoveryId);
  assert.deepEqual({ ...recovery }, {
    completed_at_ms: nowMs,
    outcome: 'dead_letter',
    error_code: 'stripe_reconciliation_lease_expired',
    claim_decision_id: null,
  });

  nowMs += 1;
  const retried = recoveryRepository.claimDeadLetterRecovery({
    organizationId: 7,
    eventId: 'evt_recovery_expired',
    actorUserId: 11,
    evidenceReference: 'INC-expired-2',
  });
  assert.equal(retried.status, 'processing');
  assert.equal(retried.replayed, false);
  assert.equal(retried.attemptNumber, 7);

  database.close();
});
