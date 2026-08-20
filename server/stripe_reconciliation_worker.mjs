import { createHash, randomUUID } from 'node:crypto';

const MAX_PROVIDER_ID_LENGTH = 255;
const MAX_ERROR_CODE_LENGTH = 96;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/u;
const ERROR_CODE_PATTERN = /^[a-z0-9_:-]+$/u;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const SAVEPOINT_NAME = 'billing_stripe_reconciliation_worker_write';
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;

/** Stable fail-closed error for durable Stripe reconciliation worker operations. */
export class StripeReconciliationWorkerError extends Error {
  /**
   * Create one sanitized worker failure.
   * @param {string} code stable machine-readable failure code
   * @param {number} [status=400] HTTP-compatible status for a future adapter
   */
  constructor(code, status = 400) {
    super(code);
    this.name = 'StripeReconciliationWorkerError';
    this.code = code;
    this.status = status;
  }
}

function workerError(code, status = 400) {
  return new StripeReconciliationWorkerError(code, status);
}

function boundedIdentifier(value, pattern) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || !pattern.test(value)
  ) {
    throw workerError('stripe_reconciliation_worker_invalid');
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function boundedPositiveOption(value, fallback, name) {
  if (value === undefined) return fallback;
  return positiveInteger(value, name);
}

function normalizedNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw workerError('stripe_reconciliation_worker_clock_invalid', 500);
  }
  return value;
}

function leaseTokenValue(randomToken) {
  const value = randomToken();
  if (typeof value !== 'string' || !LEASE_TOKEN_PATTERN.test(value)) {
    throw workerError('stripe_reconciliation_worker_token_invalid', 500);
  }
  return value;
}

function tokenHash(value) {
  const token = boundedIdentifier(value, LEASE_TOKEN_PATTERN);
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeErrorCode(error) {
  const candidate = error && typeof error === 'object' ? error.code : null;
  if (
    typeof candidate === 'string'
    && candidate.startsWith('stripe_')
    && candidate.length <= MAX_ERROR_CODE_LENGTH
    && ERROR_CODE_PATTERN.test(candidate)
  ) {
    return candidate;
  }
  return 'stripe_reconciliation_failed';
}

function boundedFailureCode(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_ERROR_CODE_LENGTH
    || !ERROR_CODE_PATTERN.test(value)
  ) {
    throw workerError('stripe_reconciliation_worker_invalid');
  }
  return value;
}

function safeAdd(left, right) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    throw workerError('stripe_reconciliation_worker_clock_invalid', 500);
  }
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw workerError('stripe_reconciliation_worker_clock_invalid', 500);
  }
  return sum;
}

function backoffForAttempt(attemptNumber, baseBackoffMs, maxBackoffMs) {
  const exponent = Math.min(attemptNumber - 1, 30);
  const scaled = baseBackoffMs * (2 ** exponent);
  if (!Number.isFinite(scaled)) return maxBackoffMs;
  return Math.min(scaled, maxBackoffMs);
}

function runSavepoint(database, operation) {
  database.exec(`SAVEPOINT ${SAVEPOINT_NAME}`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    return result;
  } catch (error) {
    let rollbackSucceeded = false;
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
      rollbackSucceeded = true;
    } catch {
      // An unconfirmed failed savepoint stays open instead of risking partial commit.
    }
    if (rollbackSucceeded) {
      try {
        database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
      } catch {
        // Cleanup after confirmed rollback must never replace the causal failure.
      }
    }
    throw error;
  }
}

/**
 * Install normalized durable worker state for already-queued Stripe reconciliation work.
 *
 * The immutable webhook-trigger relation remains the source of work identity. This
 * schema adds a mutable job head and append-only attempt evidence without copying
 * provider payloads, secrets, raw webhook bytes, or entitlement state.
 *
 * @param {import('node:sqlite').DatabaseSync} database open bootstrapped SQLite database
 * @returns {void}
 */
export function installStripeReconciliationWorkerSchema(database) {
  if (!database || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite exec operations');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS billing_stripe_reconciliation_jobs (
      event_id TEXT PRIMARY KEY
        REFERENCES billing_stripe_reconciliation_triggers(event_id) ON DELETE CASCADE,
      processing_state TEXT NOT NULL DEFAULT 'pending'
        CHECK(processing_state IN ('pending','processing','succeeded','dead_letter')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      next_attempt_at_ms INTEGER NOT NULL CHECK(next_attempt_at_ms >= 0),
      lease_token_sha256 TEXT
        CHECK(lease_token_sha256 IS NULL OR length(lease_token_sha256) = 64),
      lease_expires_at_ms INTEGER CHECK(lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
      completed_at_ms INTEGER CHECK(completed_at_ms IS NULL OR completed_at_ms >= 0),
      last_error_code TEXT
        CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND ${MAX_ERROR_CODE_LENGTH}),
      claim_decision_id INTEGER CHECK(claim_decision_id IS NULL OR claim_decision_id > 0),
      CHECK(
        (processing_state = 'processing' AND lease_token_sha256 IS NOT NULL AND lease_expires_at_ms IS NOT NULL
          AND completed_at_ms IS NULL AND claim_decision_id IS NULL)
        OR
        (processing_state = 'pending' AND lease_token_sha256 IS NULL AND lease_expires_at_ms IS NULL
          AND completed_at_ms IS NULL AND claim_decision_id IS NULL)
        OR
        (processing_state = 'succeeded' AND lease_token_sha256 IS NULL AND lease_expires_at_ms IS NULL
          AND completed_at_ms IS NOT NULL AND claim_decision_id IS NOT NULL)
        OR
        (processing_state = 'dead_letter' AND lease_token_sha256 IS NULL AND lease_expires_at_ms IS NULL
          AND completed_at_ms IS NOT NULL AND claim_decision_id IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS billing_stripe_reconciliation_attempts (
      attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL
        REFERENCES billing_stripe_reconciliation_jobs(event_id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
      lease_started_at_ms INTEGER NOT NULL CHECK(lease_started_at_ms >= 0),
      lease_expires_at_ms INTEGER NOT NULL CHECK(lease_expires_at_ms >= lease_started_at_ms),
      finished_at_ms INTEGER CHECK(finished_at_ms IS NULL OR finished_at_ms >= lease_started_at_ms),
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('succeeded','retry','dead_letter')),
      error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND ${MAX_ERROR_CODE_LENGTH}),
      UNIQUE(event_id, attempt_number)
    );

    CREATE INDEX IF NOT EXISTS billing_stripe_reconciliation_ready_jobs
      ON billing_stripe_reconciliation_jobs(processing_state, next_attempt_at_ms, event_id);
    CREATE INDEX IF NOT EXISTS billing_stripe_reconciliation_attempt_history
      ON billing_stripe_reconciliation_attempts(event_id, attempt_number);
  `);
}

/**
 * Create the SQLite repository that leases, retries, completes, and dead-letters queued work.
 *
 * Lease secrets are returned only to the claiming worker and persisted as SHA-256 hashes.
 * Every claim first imports any immutable trigger that does not yet have a worker job and
 * reclaims expired leases. Retry timing is exponential and capped; the maximum attempt
 * budget is finite so a permanently failing provider cannot create a hot loop forever.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped SQLite database
 * @param {object} [options] deterministic runtime controls
 * @param {() => number} [options.now] wall-clock milliseconds
 * @param {() => string} [options.randomToken] opaque lease-token generator
 * @param {number} [options.leaseMs=30000] lease lifetime
 * @param {number} [options.maxAttempts=5] total attempt budget
 * @param {number} [options.baseBackoffMs=5000] first retry delay
 * @param {number} [options.maxBackoffMs=300000] retry-delay ceiling
 * @returns {Readonly<object>} durable worker repository
 */
export function createSqliteStripeReconciliationWorkerRepository(database, {
  now = Date.now,
  randomToken = randomUUID,
  leaseMs = DEFAULT_LEASE_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
} = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite prepare/exec operations');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof randomToken !== 'function') throw new TypeError('randomToken must be a function');

  const normalizedLeaseMs = boundedPositiveOption(leaseMs, DEFAULT_LEASE_MS, 'leaseMs');
  const normalizedMaxAttempts = boundedPositiveOption(maxAttempts, DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
  const normalizedBaseBackoffMs = boundedPositiveOption(
    baseBackoffMs,
    DEFAULT_BASE_BACKOFF_MS,
    'baseBackoffMs',
  );
  const normalizedMaxBackoffMs = boundedPositiveOption(
    maxBackoffMs,
    DEFAULT_MAX_BACKOFF_MS,
    'maxBackoffMs',
  );
  if (normalizedBaseBackoffMs > normalizedMaxBackoffMs) {
    throw new TypeError('baseBackoffMs must not exceed maxBackoffMs');
  }

  const seedJobs = database.prepare(`
    INSERT OR IGNORE INTO billing_stripe_reconciliation_jobs(
      event_id, processing_state, attempt_count, next_attempt_at_ms,
      lease_token_sha256, lease_expires_at_ms, completed_at_ms,
      last_error_code, claim_decision_id
    )
    SELECT event_id, 'pending', 0, queued_at_ms, NULL, NULL, NULL, NULL, NULL
      FROM billing_stripe_reconciliation_triggers
  `);
  const expiredJobs = database.prepare(`
    SELECT event_id, attempt_count
      FROM billing_stripe_reconciliation_jobs
     WHERE processing_state = 'processing' AND lease_expires_at_ms <= ?
     ORDER BY lease_expires_at_ms, event_id
  `);
  const expireAttempt = database.prepare(`
    UPDATE billing_stripe_reconciliation_attempts
       SET finished_at_ms = ?, outcome = 'retry', error_code = 'stripe_reconciliation_lease_expired'
     WHERE event_id = ? AND attempt_number = ? AND outcome IS NULL
  `);
  const releaseExpiredJob = database.prepare(`
    UPDATE billing_stripe_reconciliation_jobs
       SET processing_state = 'pending', next_attempt_at_ms = ?,
           lease_token_sha256 = NULL, lease_expires_at_ms = NULL,
           last_error_code = 'stripe_reconciliation_lease_expired'
     WHERE event_id = ? AND processing_state = 'processing' AND lease_expires_at_ms <= ?
  `);
  const selectReady = database.prepare(`
    SELECT jobs.event_id, triggers.subscription_id, jobs.attempt_count
      FROM billing_stripe_reconciliation_jobs AS jobs
      JOIN billing_stripe_reconciliation_triggers AS triggers USING(event_id)
     WHERE jobs.processing_state = 'pending'
       AND jobs.next_attempt_at_ms <= ?
       AND jobs.attempt_count < ?
     ORDER BY jobs.next_attempt_at_ms, triggers.queued_at_ms, jobs.event_id
     LIMIT 1
  `);
  const claimJob = database.prepare(`
    UPDATE billing_stripe_reconciliation_jobs
       SET processing_state = 'processing', attempt_count = attempt_count + 1,
           lease_token_sha256 = ?, lease_expires_at_ms = ?, last_error_code = NULL
     WHERE event_id = ? AND processing_state = 'pending'
       AND next_attempt_at_ms <= ? AND attempt_count = ?
  `);
  const insertAttempt = database.prepare(`
    INSERT INTO billing_stripe_reconciliation_attempts(
      event_id, attempt_number, lease_started_at_ms, lease_expires_at_ms,
      finished_at_ms, outcome, error_code
    ) VALUES(?,?,?,?,NULL,NULL,NULL)
  `);
  const selectLease = database.prepare(`
    SELECT attempt_count, lease_token_sha256, lease_expires_at_ms
      FROM billing_stripe_reconciliation_jobs
     WHERE event_id = ? AND processing_state = 'processing'
  `);
  const completeJob = database.prepare(`
    UPDATE billing_stripe_reconciliation_jobs
       SET processing_state = 'succeeded', next_attempt_at_ms = ?,
           lease_token_sha256 = NULL, lease_expires_at_ms = NULL,
           completed_at_ms = ?, last_error_code = NULL, claim_decision_id = ?
     WHERE event_id = ? AND processing_state = 'processing' AND lease_token_sha256 = ?
  `);
  const finishAttempt = database.prepare(`
    UPDATE billing_stripe_reconciliation_attempts
       SET finished_at_ms = ?, outcome = ?, error_code = ?
     WHERE event_id = ? AND attempt_number = ? AND outcome IS NULL
  `);
  const retryJob = database.prepare(`
    UPDATE billing_stripe_reconciliation_jobs
       SET processing_state = ?, next_attempt_at_ms = ?,
           lease_token_sha256 = NULL, lease_expires_at_ms = NULL,
           completed_at_ms = ?, last_error_code = ?, claim_decision_id = NULL
     WHERE event_id = ? AND processing_state = 'processing' AND lease_token_sha256 = ?
  `);
  const selectOrganization = database.prepare(`
    SELECT customers.org_id AS organization_id
      FROM billing_stripe_subscriptions AS subscriptions
      JOIN billing_stripe_customers AS customers
        ON customers.customer_id = subscriptions.customer_id
     WHERE subscriptions.subscription_id = ?
  `);

  function assertCurrentLease(eventId, leaseToken, nowMs) {
    const normalizedEventId = boundedIdentifier(eventId, EVENT_ID_PATTERN);
    const normalizedLeaseToken = boundedIdentifier(leaseToken, LEASE_TOKEN_PATTERN);
    const leaseHash = tokenHash(normalizedLeaseToken);
    const current = selectLease.get(normalizedEventId);
    if (!current
      || current.lease_token_sha256 !== leaseHash
      || !Number.isSafeInteger(current.lease_expires_at_ms)
      || current.lease_expires_at_ms <= nowMs) {
      throw workerError('stripe_reconciliation_lease_stale', 409);
    }
    return {
      eventId: normalizedEventId,
      attemptNumber: positiveInteger(current.attempt_count, 'attemptNumber'),
      leaseHash,
    };
  }

  return Object.freeze({
    /** Claim at most one ready trigger under an opaque finite lease. */
    claimNext() {
      const nowMs = normalizedNow(now);
      return runSavepoint(database, () => {
        seedJobs.run();
        for (const expired of expiredJobs.all(nowMs)) {
          const attemptNumber = positiveInteger(expired.attempt_count, 'attemptNumber');
          expireAttempt.run(nowMs, expired.event_id, attemptNumber);
          releaseExpiredJob.run(nowMs, expired.event_id, nowMs);
        }

        const candidate = selectReady.get(nowMs, normalizedMaxAttempts);
        if (!candidate) return null;
        const eventId = boundedIdentifier(candidate.event_id, EVENT_ID_PATTERN);
        const subscriptionId = boundedIdentifier(candidate.subscription_id, SUBSCRIPTION_ID_PATTERN);
        const previousAttemptCount = nonNegativeInteger(candidate.attempt_count, 'attemptCount');
        const leaseToken = leaseTokenValue(randomToken);
        const leaseHash = tokenHash(leaseToken);
        const leaseExpiresAtMs = safeAdd(nowMs, normalizedLeaseMs);
        const claim = claimJob.run(
          leaseHash,
          leaseExpiresAtMs,
          eventId,
          nowMs,
          previousAttemptCount,
        );
        if (Number(claim.changes) !== 1) {
          throw workerError('stripe_reconciliation_claim_conflict', 409);
        }
        const attemptNumber = previousAttemptCount + 1;
        insertAttempt.run(eventId, attemptNumber, nowMs, leaseExpiresAtMs);
        return Object.freeze({
          eventId,
          subscriptionId,
          attemptNumber,
          leaseToken,
          leaseExpiresAtMs,
        });
      });
    },

    /** Resolve local tenant authority from the normalized Customer/Subscription identity chain. */
    resolveOrganizationId(subscriptionId) {
      const normalizedSubscriptionId = boundedIdentifier(subscriptionId, SUBSCRIPTION_ID_PATTERN);
      const row = selectOrganization.get(normalizedSubscriptionId);
      if (!row) return null;
      return positiveInteger(Number(row.organization_id), 'organizationId');
    },

    /** Complete a currently leased job with one validated durable claim decision identity. */
    complete({ eventId, leaseToken, claimDecisionId } = {}) {
      const nowMs = normalizedNow(now);
      const decisionId = positiveInteger(claimDecisionId, 'claimDecisionId');
      return runSavepoint(database, () => {
        const lease = assertCurrentLease(eventId, leaseToken, nowMs);
        const completed = completeJob.run(
          nowMs,
          nowMs,
          decisionId,
          lease.eventId,
          lease.leaseHash,
        );
        if (Number(completed.changes) !== 1) {
          throw workerError('stripe_reconciliation_lease_stale', 409);
        }
        finishAttempt.run(
          nowMs,
          'succeeded',
          null,
          lease.eventId,
          lease.attemptNumber,
        );
        return Object.freeze({
          eventId: lease.eventId,
          status: 'succeeded',
          claimDecisionId: decisionId,
        });
      });
    },

    /** Record a sanitized retry or terminal dead-letter result for the current lease. */
    fail({ eventId, leaseToken, errorCode } = {}) {
      const nowMs = normalizedNow(now);
      const normalizedErrorCode = boundedFailureCode(errorCode);
      return runSavepoint(database, () => {
        const lease = assertCurrentLease(eventId, leaseToken, nowMs);
        const deadLetter = lease.attemptNumber >= normalizedMaxAttempts;
        const status = deadLetter ? 'dead_letter' : 'retry';
        const nextAttemptAtMs = deadLetter
          ? nowMs
          : safeAdd(
            nowMs,
            backoffForAttempt(
              lease.attemptNumber,
              normalizedBaseBackoffMs,
              normalizedMaxBackoffMs,
            ),
          );
        const updated = retryJob.run(
          deadLetter ? 'dead_letter' : 'pending',
          nextAttemptAtMs,
          deadLetter ? nowMs : null,
          normalizedErrorCode,
          lease.eventId,
          lease.leaseHash,
        );
        if (Number(updated.changes) !== 1) {
          throw workerError('stripe_reconciliation_lease_stale', 409);
        }
        finishAttempt.run(
          nowMs,
          deadLetter ? 'dead_letter' : 'retry',
          normalizedErrorCode,
          lease.eventId,
          lease.attemptNumber,
        );
        return Object.freeze({
          eventId: lease.eventId,
          status,
          errorCode: normalizedErrorCode,
          nextAttemptAtMs: deadLetter ? null : nextAttemptAtMs,
        });
      });
    },
  });
}

/**
 * Consume at most one queued Stripe reconciliation trigger.
 *
 * Tenant identity is resolved from server-owned normalized Stripe identity tables;
 * callers cannot select an organization. The authoritative reconciliation service
 * then re-fetches current provider state. A valid receipt must remain bound to the
 * claimed Subscription and resolved organization before the lease may complete.
 * Missing identity and causal failures remain durable retry/dead-letter evidence;
 * arbitrary exception text is never persisted.
 *
 * @param {object} input worker orchestration ports
 * @param {object} input.repository durable worker repository
 * @param {Function} input.reconcile authoritative billing reconciliation function
 * @param {object} [input.reconciliationDependencies] server-owned dependency ports/options
 * @returns {Promise<Readonly<object>>} idle, retry/dead-letter, or success receipt
 */
export async function runNextStripeReconciliationJob({
  repository,
  reconcile,
  reconciliationDependencies = {},
}) {
  if (!repository || typeof repository.claimNext !== 'function'
    || typeof repository.resolveOrganizationId !== 'function'
    || typeof repository.complete !== 'function'
    || typeof repository.fail !== 'function') {
    throw new TypeError('repository must provide claim, authority, completion, and failure operations');
  }
  if (typeof reconcile !== 'function') throw new TypeError('reconcile must be a function');
  if (!reconciliationDependencies || typeof reconciliationDependencies !== 'object'
    || Array.isArray(reconciliationDependencies)) {
    throw new TypeError('reconciliationDependencies must be an object');
  }

  const claim = repository.claimNext();
  if (claim == null) return Object.freeze({ status: 'idle' });
  const organizationId = repository.resolveOrganizationId(claim.subscriptionId);
  if (organizationId == null) {
    return repository.fail({
      eventId: claim.eventId,
      leaseToken: claim.leaseToken,
      errorCode: 'stripe_reconciliation_authority_missing',
    });
  }

  try {
    const receipt = await reconcile({
      organizationId,
      subscriptionId: claim.subscriptionId,
      sourceEventId: claim.eventId,
      ...reconciliationDependencies,
    });
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || receipt.organizationId !== organizationId
      || receipt.subscriptionId !== claim.subscriptionId) {
      throw workerError('stripe_reconciliation_receipt_mismatch', 500);
    }
    const claimDecisionId = positiveInteger(receipt.claimDecisionId, 'claimDecisionId');
    repository.complete({
      eventId: claim.eventId,
      leaseToken: claim.leaseToken,
      claimDecisionId,
    });
    return Object.freeze({
      status: 'succeeded',
      eventId: claim.eventId,
      subscriptionId: claim.subscriptionId,
      organizationId,
      claimDecisionId,
    });
  } catch (error) {
    const failure = repository.fail({
      eventId: claim.eventId,
      leaseToken: claim.leaseToken,
      errorCode: safeErrorCode(error),
    });
    return Object.freeze({
      ...failure,
      subscriptionId: claim.subscriptionId,
      organizationId,
    });
  }
}
