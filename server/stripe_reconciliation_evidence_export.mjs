import { createHash } from 'node:crypto';

const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 100;
const MAX_NESTED_EVIDENCE_ROWS = 1_000;
const MAX_PROVIDER_ID_LENGTH = 255;
const MAX_EVENT_TYPE_LENGTH = 255;
const MAX_ERROR_CODE_LENGTH = 96;
const MAX_EVIDENCE_REFERENCE_LENGTH = 256;
const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const ERROR_CODE_PATTERN = /^[a-z0-9_:-]+$/u;
const PAYLOAD_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PROCESSING_STATES = new Set(['pending', 'processing', 'succeeded', 'dead_letter']);
const ATTEMPT_OUTCOMES = new Set(['succeeded', 'retry', 'dead_letter']);
const RECOVERY_OUTCOMES = new Set(['succeeded', 'dead_letter']);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const SCHEMA_VERSION = 'scopeweave.stripe-reconciliation-evidence/v1';

/** Stable fail-closed error for tenant reconciliation evidence exports. */
export class StripeReconciliationEvidenceExportError extends Error {
  /**
   * Create one sanitized evidence-export failure.
   * @param {string} code stable machine-readable failure code
   * @param {number} [status=400] HTTP-compatible status for an API adapter
   */
  constructor(code, status = 400) {
    super(code);
    this.name = 'StripeReconciliationEvidenceExportError';
    this.code = code;
    this.status = status;
  }
}

function exportError(code = 'stripe_reconciliation_evidence_export_invalid', status = 400) {
  return new StripeReconciliationEvidenceExportError(code, status);
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw exportError();
  return value;
}

function nonNegativeInteger(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw exportError(undefined, 500);
  return normalized;
}

function nullableNonNegativeInteger(value) {
  return value == null ? null : nonNegativeInteger(value);
}

function nullablePositiveInteger(value) {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw exportError(undefined, 500);
  return normalized;
}

function boundedIdentifier(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || !PROVIDER_IDENTIFIER_PATTERN.test(value)
  ) {
    throw exportError(undefined, 500);
  }
  return value;
}

function eventTypeValue(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_EVENT_TYPE_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw exportError(undefined, 500);
  }
  return value;
}

function nullableErrorCode(value) {
  if (value == null) return null;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_ERROR_CODE_LENGTH
    || !ERROR_CODE_PATTERN.test(value)
  ) {
    throw exportError(undefined, 500);
  }
  return value;
}

function payloadSha256Value(value) {
  if (typeof value !== 'string' || !PAYLOAD_SHA256_PATTERN.test(value)) {
    throw exportError(undefined, 500);
  }
  return value;
}

function processingStateValue(value) {
  if (!PROCESSING_STATES.has(value)) throw exportError(undefined, 500);
  return value;
}

function nullableOutcome(value, allowed) {
  if (value == null) return null;
  if (!allowed.has(value)) throw exportError(undefined, 500);
  return value;
}

function eventLimitValue(value) {
  if (value === undefined) return DEFAULT_EVENT_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_EVENT_LIMIT) {
    throw exportError();
  }
  return value;
}

function evidenceReferenceDigest(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_EVIDENCE_REFERENCE_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw exportError(undefined, 500);
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function frozenAttempt(row) {
  const outcome = nullableOutcome(row.outcome, ATTEMPT_OUTCOMES);
  const leaseStartedAtMs = nonNegativeInteger(row.lease_started_at_ms);
  const leaseExpiresAtMs = nonNegativeInteger(row.lease_expires_at_ms);
  const finishedAtMs = nullableNonNegativeInteger(row.finished_at_ms);
  const errorCode = nullableErrorCode(row.error_code);
  if (leaseExpiresAtMs < leaseStartedAtMs || (finishedAtMs != null && finishedAtMs < leaseStartedAtMs)) {
    throw exportError(undefined, 500);
  }
  if (outcome == null && (finishedAtMs != null || errorCode != null)) throw exportError(undefined, 500);
  if (outcome === 'succeeded' && errorCode != null) throw exportError(undefined, 500);
  if ((outcome === 'retry' || outcome === 'dead_letter') && errorCode == null) {
    throw exportError(undefined, 500);
  }

  return Object.freeze({
    attemptNumber: positiveInteger(Number(row.attempt_number)),
    leaseStartedAtMs,
    leaseExpiresAtMs,
    finishedAtMs,
    outcome,
    errorCode,
  });
}

function frozenRecovery(row) {
  const outcome = nullableOutcome(row.outcome, RECOVERY_OUTCOMES);
  const requestedAtMs = nonNegativeInteger(row.requested_at_ms);
  const completedAtMs = nullableNonNegativeInteger(row.completed_at_ms);
  const errorCode = nullableErrorCode(row.error_code);
  const claimDecisionId = nullablePositiveInteger(row.claim_decision_id);
  if (completedAtMs != null && completedAtMs < requestedAtMs) throw exportError(undefined, 500);
  if (outcome == null && (completedAtMs != null || errorCode != null || claimDecisionId != null)) {
    throw exportError(undefined, 500);
  }
  if (outcome === 'succeeded' && (completedAtMs == null || errorCode != null || claimDecisionId == null)) {
    throw exportError(undefined, 500);
  }
  if (outcome === 'dead_letter' && (completedAtMs == null || errorCode == null || claimDecisionId != null)) {
    throw exportError(undefined, 500);
  }

  return Object.freeze({
    recoveryId: positiveInteger(Number(row.recovery_id)),
    attemptNumber: positiveInteger(Number(row.attempt_number)),
    actorUserId: positiveInteger(Number(row.actor_user_id)),
    evidenceReferenceSha256: evidenceReferenceDigest(row.evidence_reference),
    requestedAtMs,
    completedAtMs,
    outcome,
    errorCode,
    claimDecisionId,
  });
}

function frozenEvent(row, attempts, recoveries) {
  const processingState = processingStateValue(row.processing_state);
  const completedAtMs = nullableNonNegativeInteger(row.completed_at_ms);
  const lastErrorCode = nullableErrorCode(row.last_error_code);
  const claimDecisionId = nullablePositiveInteger(row.claim_decision_id);
  const attemptCount = nonNegativeInteger(row.attempt_count);
  if (
    attempts.length !== attemptCount
    || attempts.some((attempt, index) => attempt.attemptNumber !== index + 1)
  ) {
    throw exportError(undefined, 500);
  }
  const attemptNumbers = new Set(attempts.map((attempt) => attempt.attemptNumber));
  if (recoveries.some((recovery) => !attemptNumbers.has(recovery.attemptNumber))) {
    throw exportError(undefined, 500);
  }

  const lifecycleInvalid =
    (processingState === 'pending' && (completedAtMs != null || claimDecisionId != null))
    || (processingState === 'processing'
      && (completedAtMs != null || lastErrorCode != null || claimDecisionId != null))
    || (processingState === 'succeeded'
      && (completedAtMs == null || lastErrorCode != null || claimDecisionId == null))
    || (processingState === 'dead_letter'
      && (completedAtMs == null || lastErrorCode == null || claimDecisionId != null));
  if (lifecycleInvalid) throw exportError(undefined, 500);

  const latestAttempt = attempts.at(-1) ?? null;
  const latestAttemptLifecycleInvalid =
    (processingState === 'pending' && latestAttempt != null && latestAttempt.outcome !== 'retry')
    || (processingState === 'processing'
      && (latestAttempt == null || latestAttempt.outcome !== null))
    || (processingState === 'succeeded'
      && (latestAttempt == null || latestAttempt.outcome !== 'succeeded'))
    || (processingState === 'dead_letter'
      && (latestAttempt == null || latestAttempt.outcome !== 'dead_letter'));
  if (latestAttemptLifecycleInvalid) throw exportError(undefined, 500);

  return Object.freeze({
    eventId: boundedIdentifier(row.event_id),
    subscriptionId: boundedIdentifier(row.subscription_id),
    eventType: eventTypeValue(row.event_type),
    providerCreatedAtSec: nonNegativeInteger(row.provider_created_at_sec),
    payloadSha256: payloadSha256Value(row.payload_sha256),
    firstReceivedAtMs: nonNegativeInteger(row.first_received_at_ms),
    queuedAtMs: nonNegativeInteger(row.queued_at_ms),
    processingState,
    attemptCount,
    nextAttemptAtMs: nonNegativeInteger(row.next_attempt_at_ms),
    completedAtMs,
    lastErrorCode,
    claimDecisionId,
    attempts: Object.freeze(attempts),
    recoveries: Object.freeze(recoveries),
  });
}

/**
 * Create the read-only tenant evidence export repository.
 *
 * Tenant authority is derived exclusively through the normalized persisted
 * Subscription -> Customer -> organization chain. The export never returns raw
 * webhook payloads, provider credentials, active lease-token hashes, or free-form
 * recovery evidence text. Operator evidence remains correlatable through SHA-256.
 * Event selection is capped at 100 and the combined nested attempt/recovery history
 * is capped at 1,000 rows before those histories are materialized.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped SQLite database
 * @returns {{exportTenantEvidence(input:{organizationId:number,limit?:number}):Readonly<object>}}
 * bounded read-only evidence port
 */
export function createSqliteStripeReconciliationEvidenceExportRepository(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('database must provide SQLite prepare operations');
  }

  const selectEvents = database.prepare(`
    SELECT
      j.event_id,
      t.subscription_id,
      e.event_type,
      e.provider_created_at_sec,
      e.payload_sha256,
      e.first_received_at_ms,
      t.queued_at_ms,
      j.processing_state,
      j.attempt_count,
      j.next_attempt_at_ms,
      j.completed_at_ms,
      j.last_error_code,
      j.claim_decision_id
    FROM billing_stripe_reconciliation_jobs AS j
    JOIN billing_stripe_reconciliation_triggers AS t ON t.event_id = j.event_id
    JOIN billing_stripe_webhook_events AS e ON e.event_id = j.event_id
    JOIN billing_stripe_subscriptions AS s ON s.subscription_id = t.subscription_id
    JOIN billing_stripe_customers AS c ON c.customer_id = s.customer_id
    WHERE c.organization_id = ?
    ORDER BY t.queued_at_ms DESC, j.event_id DESC
    LIMIT ?
  `);
  const countNestedEvidence = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM billing_stripe_reconciliation_attempts WHERE event_id = ?) +
      (SELECT COUNT(*) FROM billing_stripe_reconciliation_recoveries WHERE event_id = ?)
      AS evidence_row_count
  `);
  const selectAttempts = database.prepare(`
    SELECT attempt_number, lease_started_at_ms, lease_expires_at_ms,
           finished_at_ms, outcome, error_code
      FROM billing_stripe_reconciliation_attempts
     WHERE event_id = ?
     ORDER BY attempt_number ASC
  `);
  const selectRecoveries = database.prepare(`
    SELECT recovery_id, attempt_number, actor_user_id, evidence_reference,
           requested_at_ms, completed_at_ms, outcome, error_code, claim_decision_id
      FROM billing_stripe_reconciliation_recoveries
     WHERE event_id = ?
     ORDER BY recovery_id ASC
  `);

  return Object.freeze({
    /**
     * Export one tenant's bounded reconciliation evidence without mutation.
     * @param {{organizationId:number,limit?:number}} input tenant and event ceiling
     * @returns {Readonly<{schemaVersion:string,organizationId:number,events:ReadonlyArray<object>}>}
     * immutable evidence document
     */
    exportTenantEvidence({ organizationId, limit } = {}) {
      const tenantId = positiveInteger(organizationId);
      const eventLimit = eventLimitValue(limit);
      const eventRows = selectEvents.all(tenantId, eventLimit);

      let nestedRows = 0;
      for (const row of eventRows) {
        const eventId = boundedIdentifier(row.event_id);
        const count = countNestedEvidence.get(eventId, eventId)?.evidence_row_count;
        const normalizedCount = nonNegativeInteger(count);
        nestedRows += normalizedCount;
        if (!Number.isSafeInteger(nestedRows) || nestedRows > MAX_NESTED_EVIDENCE_ROWS) {
          throw exportError('stripe_reconciliation_evidence_export_too_large', 413);
        }
      }

      const events = eventRows.map((row) => {
        const eventId = boundedIdentifier(row.event_id);
        const attempts = selectAttempts.all(eventId).map(frozenAttempt);
        const recoveries = selectRecoveries.all(eventId).map(frozenRecovery);
        return frozenEvent(row, attempts, recoveries);
      });

      return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        organizationId: tenantId,
        events: Object.freeze(events),
      });
    },
  });
}
