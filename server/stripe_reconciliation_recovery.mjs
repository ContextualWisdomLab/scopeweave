import { createHash, randomUUID } from 'node:crypto';

const MAX_PROVIDER_ID_LENGTH = 255;
const MAX_EVIDENCE_REFERENCE_LENGTH = 256;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_LEASE_MS = 90_000;
const LEASE_EXPIRED_CODE = 'stripe_reconciliation_lease_expired';
const EVENT_ID_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/u;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const ERROR_CODE_PATTERN = /^[a-z0-9_:-]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const SAVEPOINT_NAME = 'billing_stripe_reconciliation_recovery_write';

/** Stable fail-closed error for operator-initiated Stripe reconciliation recovery. */
export class StripeReconciliationRecoveryError extends Error {
  /**
   * Create one sanitized recovery failure.
   * @param {string} code stable machine-readable failure code
   * @param {number} [status=400] HTTP-compatible status for an API adapter
   */
  constructor(code, status = 400) {
    super(code);
    this.name = 'StripeReconciliationRecoveryError';
    this.code = code;
    this.status = status;
  }
}

function recoveryError(code, status = 400) {
  return new StripeReconciliationRecoveryError(code, status);
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw recoveryError('stripe_reconciliation_recovery_invalid');
  }
  return value;
}

function boundedIdentifier(value, pattern) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || !pattern.test(value)
  ) {
    throw recoveryError('stripe_reconciliation_recovery_invalid');
  }
  return value;
}

function evidenceReferenceValue(value) {
  if (typeof value !== 'string') {
    throw recoveryError('stripe_reconciliation_recovery_invalid');
  }
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_EVIDENCE_REFERENCE_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw recoveryError('stripe_reconciliation_recovery_invalid');
  }
  return normalized;
}

function listLimitValue(value) {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIST_LIMIT) {
    throw recoveryError('stripe_reconciliation_recovery_invalid');
  }
  return value;
}

function normalizedNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw recoveryError('stripe_reconciliation_recovery_clock_invalid', 500);
  }
  return value;
}

function leaseTokenValue(randomToken) {
  const value = randomToken();
  if (typeof value !== 'string' || !LEASE_TOKEN_PATTERN.test(value)) {
    throw recoveryError('stripe_reconciliation_recovery_token_invalid', 500);
  }
  return value;
}

function tokenHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeAdd(left, right) {
  const value = left + right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)
    || left < 0 || right <= 0 || !Number.isSafeInteger(value)) {
    throw recoveryError('stripe_reconciliation_recovery_clock_invalid', 500);
  }
  return value;
}

function safeFailureCode(error) {
  const code = error && typeof error === 'object' ? error.code : null;
  if (
    typeof code === 'string'
    && code.startsWith('stripe_')
    && code.length <= 96
    && ERROR_CODE_PATTERN.test(code)
  ) {
    return code;
  }
  return 'stripe_reconciliation_recovery_failed';
}

function withSavepoint(database, operation) {
  database.exec(`SAVEPOINT ${SAVEPOINT_NAME}`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    return result;
  } catch (error) {
    let rolledBack = false;
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
      rolledBack = true;
    } catch {
      // Leave an unconfirmed failed savepoint open instead of risking partial commit.
    }
    if (rolledBack) {
      try {
        database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
      } catch {
        // Cleanup after a confirmed rollback must not replace the causal failure.
      }
    }
    throw error;
  }
}

function replayReceipt(row) {
  if (!row) return null;
  const base = {
    recoveryId: positiveInteger(Number(row.recovery_id)),
    eventId: boundedIdentifier(row.event_id, EVENT_ID_PATTERN),
    subscriptionId: boundedIdentifier(row.subscription_id, SUBSCRIPTION_ID_PATTERN),
    attemptNumber: positiveInteger(Number(row.attempt_number)),
  };
  const effectiveOutcome = row.recovery_outcome ?? row.attempt_outcome;
  if (effectiveOutcome == null) {
    return Object.freeze({ status: 'processing', replayed: true, ...base });
  }
  if (effectiveOutcome === 'succeeded') {
    return Object.freeze({
      status: 'succeeded',
      replayed: true,
      ...base,
      claimDecisionId: positiveInteger(Number(row.recovery_claim_decision_id ?? row.job_claim_decision_id)),
    });
  }
  if (effectiveOutcome === 'dead_letter') {
    const errorCode = row.recovery_error_code ?? row.attempt_error_code;
    if (typeof errorCode !== 'string' || !ERROR_CODE_PATTERN.test(errorCode)) {
      throw recoveryError('stripe_reconciliation_recovery_state_invalid', 500);
    }
    return Object.freeze({ status: 'dead_letter', replayed: true, ...base, errorCode });
  }
  throw recoveryError('stripe_reconciliation_recovery_state_invalid', 500);
}

/**
 * Install immutable operator-recovery evidence for Stripe reconciliation dead letters.
 *
 * Recovery authority is normalized: tenant identity stays on the existing
 * Subscription→Customer chain, attempt outcome stays on worker attempt history, and
 * this table records only who authorized which exact manual attempt and why. The
 * evidence reference is idempotency authority for one event and is never a provider
 * credential or browser capability.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped SQLite database
 * @returns {void}
 */
export function installStripeReconciliationRecoverySchema(database) {
  if (!database || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite exec operations');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS billing_stripe_reconciliation_recoveries (
      recovery_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
      actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      evidence_reference TEXT NOT NULL
        CHECK(length(evidence_reference) BETWEEN 1 AND ${MAX_EVIDENCE_REFERENCE_LENGTH}),
      requested_at_ms INTEGER NOT NULL CHECK(requested_at_ms >= 0),
      completed_at_ms INTEGER CHECK(completed_at_ms IS NULL OR completed_at_ms >= requested_at_ms),
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('succeeded','dead_letter')),
      error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 96),
      claim_decision_id INTEGER CHECK(claim_decision_id IS NULL OR claim_decision_id > 0),
      FOREIGN KEY(event_id, attempt_number)
        REFERENCES billing_stripe_reconciliation_attempts(event_id, attempt_number)
        ON DELETE RESTRICT,
      UNIQUE(event_id, evidence_reference),
      CHECK(
        (outcome IS NULL AND completed_at_ms IS NULL
          AND error_code IS NULL AND claim_decision_id IS NULL)
        OR
        (outcome = 'succeeded' AND completed_at_ms IS NOT NULL
          AND error_code IS NULL AND claim_decision_id IS NOT NULL)
        OR
        (outcome = 'dead_letter' AND completed_at_ms IS NOT NULL
          AND error_code IS NOT NULL AND claim_decision_id IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS billing_stripe_reconciliation_recovery_actor_history
      ON billing_stripe_reconciliation_recoveries(actor_user_id, requested_at_ms, recovery_id);
  `);
}

/**
 * Create the tenant-scoped repository used by operator dead-letter recovery.
 *
 * A manual recovery never resets automatic attempt history. It adds exactly one new
 * leased attempt after a dead letter, preserving every prior attempt. Reusing the
 * same event/evidence-reference pair returns the existing recovery receipt without
 * creating another provider call or attempt. A fresh explicit evidence reference is
 * required for another manual attempt.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped SQLite database
 * @param {object} [options] deterministic runtime controls
 * @param {() => number} [options.now] wall-clock milliseconds
 * @param {() => string} [options.randomToken] opaque lease-token generator
 * @param {number} [options.leaseMs=90000] manual recovery lease lifetime
 * @returns {Readonly<object>} recovery repository
 */
export function createSqliteStripeReconciliationRecoveryRepository(database, {
  now = Date.now,
  randomToken = randomUUID,
  leaseMs = DEFAULT_LEASE_MS,
} = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite prepare/exec operations');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof randomToken !== 'function') throw new TypeError('randomToken must be a function');
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError('leaseMs must be a positive safe integer');
  }

  const listDeadLettersQuery = database.prepare(`
    SELECT jobs.event_id, triggers.subscription_id, jobs.attempt_count,
           jobs.completed_at_ms, jobs.last_error_code
      FROM billing_stripe_reconciliation_jobs AS jobs
      JOIN billing_stripe_reconciliation_triggers AS triggers USING(event_id)
      JOIN billing_stripe_subscriptions AS subscriptions
        ON subscriptions.subscription_id = triggers.subscription_id
      JOIN billing_stripe_customers AS customers
        ON customers.customer_id = subscriptions.customer_id
     WHERE customers.organization_id = ?
       AND jobs.processing_state = 'dead_letter'
     ORDER BY jobs.completed_at_ms DESC, jobs.event_id
     LIMIT ?
  `);
  const selectDeadLetter = database.prepare(`
    SELECT jobs.event_id, triggers.subscription_id, jobs.attempt_count
      FROM billing_stripe_reconciliation_jobs AS jobs
      JOIN billing_stripe_reconciliation_triggers AS triggers USING(event_id)
      JOIN billing_stripe_subscriptions AS subscriptions
        ON subscriptions.subscription_id = triggers.subscription_id
      JOIN billing_stripe_customers AS customers
        ON customers.customer_id = subscriptions.customer_id
     WHERE customers.organization_id = ?
       AND jobs.event_id = ?
       AND jobs.processing_state = 'dead_letter'
  `);
  const selectExistingRecovery = database.prepare(`
    SELECT recoveries.recovery_id, recoveries.event_id, recoveries.attempt_number,
           recoveries.outcome AS recovery_outcome,
           recoveries.error_code AS recovery_error_code,
           recoveries.claim_decision_id AS recovery_claim_decision_id,
           attempts.outcome AS attempt_outcome,
           attempts.error_code AS attempt_error_code,
           jobs.claim_decision_id AS job_claim_decision_id,
           triggers.subscription_id
      FROM billing_stripe_reconciliation_recoveries AS recoveries
      JOIN billing_stripe_reconciliation_attempts AS attempts
        ON attempts.event_id = recoveries.event_id
       AND attempts.attempt_number = recoveries.attempt_number
      JOIN billing_stripe_reconciliation_jobs AS jobs
        ON jobs.event_id = recoveries.event_id
      JOIN billing_stripe_reconciliation_triggers AS triggers
        ON triggers.event_id = recoveries.event_id
      JOIN billing_stripe_subscriptions AS subscriptions
        ON subscriptions.subscription_id = triggers.subscription_id
      JOIN billing_stripe_customers AS customers
        ON customers.customer_id = subscriptions.customer_id
     WHERE customers.organization_id = ?
       AND recoveries.event_id = ?
       AND recoveries.evidence_reference = ?
  `);
  const selectActiveRecovery = database.prepare(`
    SELECT recoveries.recovery_id, recoveries.event_id, recoveries.attempt_number,
           jobs.attempt_count AS job_attempt_count,
           jobs.lease_expires_at_ms AS job_lease_expires_at_ms
      FROM billing_stripe_reconciliation_recoveries AS recoveries
      JOIN billing_stripe_reconciliation_attempts AS attempts
        ON attempts.event_id = recoveries.event_id
       AND attempts.attempt_number = recoveries.attempt_number
      JOIN billing_stripe_reconciliation_jobs AS jobs
        ON jobs.event_id = recoveries.event_id
      JOIN billing_stripe_reconciliation_triggers AS triggers
        ON triggers.event_id = recoveries.event_id
      JOIN billing_stripe_subscriptions AS subscriptions
        ON subscriptions.subscription_id = triggers.subscription_id
      JOIN billing_stripe_customers AS customers
        ON customers.customer_id = subscriptions.customer_id
     WHERE customers.organization_id = ?
       AND recoveries.event_id = ?
       AND recoveries.outcome IS NULL
       AND attempts.outcome IS NULL
       AND jobs.processing_state = 'processing'
       AND jobs.attempt_count = recoveries.attempt_number
     ORDER BY recoveries.recovery_id DESC
     LIMIT 1
  `);
  const claimJob = database.prepare(`
    UPDATE billing_stripe_reconciliation_jobs
       SET processing_state = 'processing',
           attempt_count = attempt_count + 1,
           next_attempt_at_ms = ?,
           lease_token_sha256 = ?,
           lease_expires_at_ms = ?,
           completed_at_ms = NULL,
           last_error_code = NULL,
           claim_decision_id = NULL
     WHERE event_id = ?
       AND processing_state = 'dead_letter'
       AND attempt_count = ?
  `);
  const insertAttempt = database.prepare(`
    INSERT INTO billing_stripe_reconciliation_attempts(
      event_id, attempt_number, lease_started_at_ms, lease_expires_at_ms,
      finished_at_ms, outcome, error_code
    ) VALUES(?,?,?,?,NULL,NULL,NULL)
  `);
  const insertRecovery = database.prepare(`
    INSERT INTO billing_stripe_reconciliation_recoveries(
      event_id, attempt_number, actor_user_id, evidence_reference,
      requested_at_ms, completed_at_ms, outcome, error_code, claim_decision_id
    ) VALUES(?,?,?,?,?,NULL,NULL,NULL,NULL)
  `);
  const finishRecoverySuccess = database.prepare(`
    UPDATE billing_stripe_reconciliation_recoveries
       SET completed_at_ms = ?, outcome = 'succeeded', error_code = NULL,
           claim_decision_id = ?
     WHERE recovery_id = ? AND event_id = ? AND attempt_number = ? AND outcome IS NULL
  `);
  const finishRecoveryFailure = database.prepare(`
    UPDATE billing_stripe_reconciliation_recoveries
       SET completed_at_ms = ?, outcome = 'dead_letter', error_code = ?,
           claim_decision_id = NULL
     WHERE recovery_id = ? AND event_id = ? AND attempt_number = ? AND outcome IS NULL
  `);
  const finishExpiredAttempt = database.prepare(`
    UPDATE billing_stripe_reconciliation_attempts
       SET finished_at_ms = ?, outcome = 'dead_letter', error_code = ?
     WHERE event_id = ? AND attempt_number = ? AND outcome IS NULL
       AND lease_expires_at_ms <= ?
  `);
  const finishExpiredJob = database.prepare(`
    UPDATE billing_stripe_reconciliation_jobs
       SET processing_state = 'dead_letter', next_attempt_at_ms = ?,
           lease_token_sha256 = NULL, lease_expires_at_ms = NULL,
           completed_at_ms = ?, last_error_code = ?, claim_decision_id = NULL
     WHERE event_id = ? AND processing_state = 'processing'
       AND attempt_count = ? AND lease_expires_at_ms <= ?
  `);

  function recoveryNow() {
    return normalizedNow(now);
  }

  function reapExpiredRecovery(orgId, eventId, nowMs) {
    const candidate = selectActiveRecovery.get(orgId, eventId);
    if (!candidate) return false;
    const candidateLeaseExpiresAtMs = Number(candidate.job_lease_expires_at_ms);
    if (!Number.isSafeInteger(candidateLeaseExpiresAtMs) || candidateLeaseExpiresAtMs < 0) {
      throw recoveryError('stripe_reconciliation_recovery_state_invalid', 500);
    }
    if (candidateLeaseExpiresAtMs > nowMs) return false;

    return withSavepoint(database, () => {
      const current = selectActiveRecovery.get(orgId, eventId);
      if (!current) return false;
      const recoveryId = positiveInteger(Number(current.recovery_id));
      const attemptNumber = positiveInteger(Number(current.attempt_number));
      const jobAttemptCount = positiveInteger(Number(current.job_attempt_count));
      const leaseExpiresAtMs = Number(current.job_lease_expires_at_ms);
      if (
        jobAttemptCount !== attemptNumber
        || !Number.isSafeInteger(leaseExpiresAtMs)
        || leaseExpiresAtMs < 0
      ) {
        throw recoveryError('stripe_reconciliation_recovery_state_invalid', 500);
      }
      if (leaseExpiresAtMs > nowMs) return false;

      const attemptUpdated = finishExpiredAttempt.run(
        nowMs,
        LEASE_EXPIRED_CODE,
        eventId,
        attemptNumber,
        nowMs,
      );
      if (Number(attemptUpdated.changes) !== 1) {
        throw recoveryError('stripe_reconciliation_recovery_state_uncertain', 500);
      }
      const jobUpdated = finishExpiredJob.run(
        nowMs,
        nowMs,
        LEASE_EXPIRED_CODE,
        eventId,
        attemptNumber,
        nowMs,
      );
      if (Number(jobUpdated.changes) !== 1) {
        throw recoveryError('stripe_reconciliation_recovery_state_uncertain', 500);
      }
      const recoveryUpdated = finishRecoveryFailure.run(
        nowMs,
        LEASE_EXPIRED_CODE,
        recoveryId,
        eventId,
        attemptNumber,
      );
      if (Number(recoveryUpdated.changes) !== 1) {
        throw recoveryError('stripe_reconciliation_recovery_state_uncertain', 500);
      }
      return true;
    });
  }

  return Object.freeze({
    /** List bounded dead-letter summaries for one exact ScopeWeave tenant. */
    listDeadLetters({ organizationId, limit } = {}) {
      const orgId = positiveInteger(organizationId);
      const boundedLimit = listLimitValue(limit);
      return listDeadLettersQuery.all(orgId, boundedLimit).map((row) => Object.freeze({
        eventId: boundedIdentifier(row.event_id, EVENT_ID_PATTERN),
        subscriptionId: boundedIdentifier(row.subscription_id, SUBSCRIPTION_ID_PATTERN),
        attemptCount: positiveInteger(Number(row.attempt_count)),
        completedAtMs: Number(row.completed_at_ms),
        lastErrorCode: row.last_error_code,
      }));
    },

    /** Claim one exact tenant-owned dead letter under new operator recovery authority. */
    claimDeadLetterRecovery({ organizationId, eventId, actorUserId, evidenceReference } = {}) {
      const orgId = positiveInteger(organizationId);
      const normalizedEventId = boundedIdentifier(eventId, EVENT_ID_PATTERN);
      const actorId = positiveInteger(actorUserId);
      const evidence = evidenceReferenceValue(evidenceReference);
      const nowMs = recoveryNow();

      reapExpiredRecovery(orgId, normalizedEventId, nowMs);
      const existing = replayReceipt(selectExistingRecovery.get(orgId, normalizedEventId, evidence));
      if (existing) return existing;

      const leaseToken = leaseTokenValue(randomToken);
      const leaseExpiresAtMs = safeAdd(nowMs, leaseMs);
      const leaseHash = tokenHash(leaseToken);

      try {
        return withSavepoint(database, () => {
          const row = selectDeadLetter.get(orgId, normalizedEventId);
          if (!row) {
            throw recoveryError('stripe_reconciliation_dead_letter_not_found', 404);
          }
          const subscriptionId = boundedIdentifier(row.subscription_id, SUBSCRIPTION_ID_PATTERN);
          const priorAttemptCount = positiveInteger(Number(row.attempt_count));
          const attemptNumber = priorAttemptCount + 1;
          if (!Number.isSafeInteger(attemptNumber)) {
            throw recoveryError('stripe_reconciliation_recovery_state_invalid', 500);
          }
          const claimed = claimJob.run(
            nowMs,
            leaseHash,
            leaseExpiresAtMs,
            normalizedEventId,
            priorAttemptCount,
          );
          if (Number(claimed.changes) !== 1) {
            throw recoveryError('stripe_reconciliation_recovery_conflict', 409);
          }
          insertAttempt.run(
            normalizedEventId,
            attemptNumber,
            nowMs,
            leaseExpiresAtMs,
          );
          const inserted = insertRecovery.run(
            normalizedEventId,
            attemptNumber,
            actorId,
            evidence,
            nowMs,
          );
          const recoveryId = positiveInteger(Number(inserted.lastInsertRowid));
          return Object.freeze({
            status: 'processing',
            replayed: false,
            recoveryId,
            eventId: normalizedEventId,
            subscriptionId,
            organizationId: orgId,
            attemptNumber,
            leaseToken,
            leaseExpiresAtMs,
          });
        });
      } catch (error) {
        const raced = replayReceipt(selectExistingRecovery.get(orgId, normalizedEventId, evidence));
        if (raced) return raced;
        throw error;
      }
    },

    /** Atomically complete the worker lease and its immutable recovery receipt. */
    completeRecovery({ claim, claimDecisionId, workerRepository } = {}) {
      if (!claim || typeof claim !== 'object' || claim.replayed !== false) {
        throw recoveryError('stripe_reconciliation_recovery_invalid');
      }
      if (!workerRepository || typeof workerRepository.complete !== 'function') {
        throw new TypeError('workerRepository must provide complete()');
      }
      const decisionId = positiveInteger(claimDecisionId);
      const nowMs = recoveryNow();
      return withSavepoint(database, () => {
        workerRepository.complete({
          eventId: claim.eventId,
          leaseToken: claim.leaseToken,
          claimDecisionId: decisionId,
        });
        const updated = finishRecoverySuccess.run(
          nowMs,
          decisionId,
          claim.recoveryId,
          claim.eventId,
          claim.attemptNumber,
        );
        if (Number(updated.changes) !== 1) {
          throw recoveryError('stripe_reconciliation_recovery_state_uncertain', 500);
        }
      });
    },

    /** Atomically dead-letter the manual worker lease and its recovery receipt. */
    failRecovery({ claim, errorCode, workerRepository } = {}) {
      if (!claim || typeof claim !== 'object' || claim.replayed !== false) {
        throw recoveryError('stripe_reconciliation_recovery_invalid');
      }
      if (!workerRepository || typeof workerRepository.fail !== 'function') {
        throw new TypeError('workerRepository must provide fail()');
      }
      const code = typeof errorCode === 'string' && ERROR_CODE_PATTERN.test(errorCode)
        ? errorCode
        : 'stripe_reconciliation_recovery_failed';
      const nowMs = recoveryNow();
      let workerResult;
      withSavepoint(database, () => {
        workerResult = workerRepository.fail({
          eventId: claim.eventId,
          leaseToken: claim.leaseToken,
          errorCode: code,
        });
        if (!workerResult || workerResult.status !== 'dead_letter') {
          throw recoveryError('stripe_reconciliation_recovery_state_uncertain', 500);
        }
        const updated = finishRecoveryFailure.run(
          nowMs,
          code,
          claim.recoveryId,
          claim.eventId,
          claim.attemptNumber,
        );
        if (Number(updated.changes) !== 1) {
          throw recoveryError('stripe_reconciliation_recovery_state_uncertain', 500);
        }
      });
      return workerResult;
    },
  });
}

function assertReconciliationReceipt(receipt, claim) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw recoveryError('stripe_reconciliation_recovery_receipt_invalid', 500);
  }
  if (receipt.organizationId !== claim.organizationId
    || receipt.subscriptionId !== claim.subscriptionId
    || !Number.isSafeInteger(receipt.claimDecisionId)
    || receipt.claimDecisionId <= 0) {
    throw recoveryError('stripe_reconciliation_recovery_receipt_invalid', 500);
  }
  return receipt.claimDecisionId;
}

/**
 * Retry one operator-approved dead letter through current Stripe provider authority.
 *
 * The caller chooses only a tenant, verified Event identity, actor, and durable evidence
 * reference. Tenant/Subscription authority comes from normalized server-owned state.
 * Replaying the same evidence reference is side-effect free. A new explicit reference
 * creates one new finite lease and attempt; failure returns immediately to dead-letter
 * state instead of reopening the automatic retry budget.
 *
 * @param {object} input recovery and reconciliation ports
 * @param {object} input.recoveryRepository tenant-scoped recovery repository
 * @param {object} input.workerRepository worker completion/failure repository
 * @param {Function} input.reconcile authoritative Stripe billing reconciliation function
 * @param {object} [input.reconciliationDependencies] server-owned provider/persistence ports
 * @param {number} input.organizationId tenant authority requested by authenticated adapter
 * @param {string} input.eventId exact verified Event dead-letter identity
 * @param {number} input.actorUserId authenticated operator user ID
 * @param {string} input.evidenceReference bounded operator evidence/idempotency reference
 * @returns {Promise<Readonly<object>>} durable replay, success, or dead-letter receipt
 */
export async function retryStripeReconciliationDeadLetter({
  recoveryRepository,
  workerRepository,
  reconcile,
  reconciliationDependencies = {},
  organizationId,
  eventId,
  actorUserId,
  evidenceReference,
}) {
  if (!recoveryRepository
    || typeof recoveryRepository.claimDeadLetterRecovery !== 'function'
    || typeof recoveryRepository.completeRecovery !== 'function'
    || typeof recoveryRepository.failRecovery !== 'function') {
    throw new TypeError('recoveryRepository must provide recovery operations');
  }
  if (!workerRepository
    || typeof workerRepository.complete !== 'function'
    || typeof workerRepository.fail !== 'function') {
    throw new TypeError('workerRepository must provide complete()/fail()');
  }
  if (typeof reconcile !== 'function') throw new TypeError('reconcile must be a function');
  if (!reconciliationDependencies || typeof reconciliationDependencies !== 'object'
    || Array.isArray(reconciliationDependencies)) {
    throw new TypeError('reconciliationDependencies must be an object');
  }

  const claim = recoveryRepository.claimDeadLetterRecovery({
    organizationId,
    eventId,
    actorUserId,
    evidenceReference,
  });
  if (claim.replayed) return claim;

  try {
    const receipt = await reconcile({
      ...reconciliationDependencies,
      organizationId: claim.organizationId,
      subscriptionId: claim.subscriptionId,
      sourceEventId: claim.eventId,
    });
    const claimDecisionId = assertReconciliationReceipt(receipt, claim);
    recoveryRepository.completeRecovery({
      claim,
      claimDecisionId,
      workerRepository,
    });
    return Object.freeze({
      status: 'succeeded',
      replayed: false,
      recoveryId: claim.recoveryId,
      eventId: claim.eventId,
      subscriptionId: claim.subscriptionId,
      attemptNumber: claim.attemptNumber,
      claimDecisionId,
    });
  } catch (error) {
    const errorCode = safeFailureCode(error);
    try {
      recoveryRepository.failRecovery({ claim, errorCode, workerRepository });
    } catch {
      throw recoveryError('stripe_reconciliation_recovery_state_uncertain', 500);
    }
    return Object.freeze({
      status: 'dead_letter',
      replayed: false,
      recoveryId: claim.recoveryId,
      eventId: claim.eventId,
      subscriptionId: claim.subscriptionId,
      attemptNumber: claim.attemptNumber,
      errorCode,
    });
  }
}
