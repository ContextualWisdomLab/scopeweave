import { randomUUID as systemRandomUUID } from 'node:crypto';

/**
 * Maximum age for automatically replaying an unresolved Stripe idempotency key.
 *
 * Stripe documents a 24-hour safe-retry horizon for POST idempotency. ScopeWeave
 * stops automatic replay one hour earlier. Crossing this local ceiling never
 * authorizes a fresh key: the attempt moves to `reconciliation_required` so a
 * potentially side-effectful provider outcome cannot be duplicated by guesswork.
 */
export const BILLING_CHECKOUT_REUSE_WINDOW_MS = 23 * 60 * 60 * 1000;

const MAX_PRICE_ID_LENGTH = 255;
const MAX_PROVIDER_SESSION_ID_LENGTH = 255;
const MAX_IDENTIFIER_LENGTH = 255;
const SAVEPOINT_NAME = 'billing_checkout_attempt_write';

/**
 * Signals that a stale or temporally ambiguous provider attempt must be resolved
 * from authoritative provider/webhook state before another Checkout can begin.
 */
export class BillingCheckoutReconciliationRequiredError extends Error {
  /** @param {string} attemptId - Opaque local attempt requiring reconciliation. */
  constructor(attemptId) {
    super('checkout attempt requires authoritative reconciliation before retry');
    this.name = 'BillingCheckoutReconciliationRequiredError';
    this.code = 'billing_checkout_reconciliation_required';
    Object.defineProperty(this, 'attemptId', {
      value: attemptId,
      enumerable: false,
    });
  }
}

function positiveOrganizationId(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError('organizationId must be a positive integer');
  }
  return parsed;
}

function boundedRequiredString(value, name, maximumLength) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new TypeError(`${name} must be a non-empty string no longer than ${maximumLength} characters`);
  }
  return normalized;
}

function safeNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('checkout attempt clock must return a non-negative safe integer');
  }
  return value;
}

function opaqueIdentifier(randomUUID, name) {
  return boundedRequiredString(randomUUID(), name, MAX_IDENTIFIER_LENGTH);
}

function withSavepoint(database, operation) {
  database.exec(`SAVEPOINT ${SAVEPOINT_NAME}`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    return result;
  } catch (error) {
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
    } finally {
      database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    }
    throw error;
  }
}

/**
 * Install the durable Checkout-attempt schema during process/database bootstrap.
 *
 * The schema is intentionally separate from request handling. One row represents
 * one provider-attempt identity; organization and price facts are referenced or
 * recorded once, while provider outcome is a state of that same attempt. The
 * partial unique index guarantees at most one unresolved or reconciliation-held
 * identity for an organization/price pair.
 *
 * @param {import('node:sqlite').DatabaseSync} database - Open SQLite database.
 * @returns {void}
 */
export function installBillingCheckoutAttemptSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS billing_checkout_attempts (
      attempt_id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      price_id TEXT NOT NULL CHECK(length(price_id) BETWEEN 1 AND ${MAX_PRICE_ID_LENGTH}),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND ${MAX_IDENTIFIER_LENGTH}),
      attempt_state TEXT NOT NULL CHECK(attempt_state IN ('pending','provider_succeeded','provider_failed','reconciliation_required')),
      provider_session_id TEXT CHECK(provider_session_id IS NULL OR length(provider_session_id) BETWEEN 1 AND ${MAX_PROVIDER_SESSION_ID_LENGTH}),
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
      CHECK(
        (attempt_state = 'provider_succeeded' AND provider_session_id IS NOT NULL)
        OR (attempt_state <> 'provider_succeeded' AND provider_session_id IS NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_checkout_unresolved_attempts
      ON billing_checkout_attempts(organization_id, price_id)
      WHERE attempt_state IN ('pending','reconciliation_required');
  `);
}

/**
 * Create the SQLite persistence port for Checkout attempt identities.
 *
 * This constructor never creates database objects. Call
 * {@link installBillingCheckoutAttemptSchema} exactly from bootstrap/migration
 * code before serving requests. SQL statements are prepared lazily so merely
 * constructing the port cannot accidentally turn missing bootstrap into schema
 * creation or another hidden startup side effect.
 *
 * @param {import('node:sqlite').DatabaseSync} database - Bootstrapped database.
 * @param {object} [dependencies] - Deterministic seams for tests.
 * @param {() => string} [dependencies.randomUUID] - Cryptographic UUID source.
 * @param {() => number} [dependencies.now] - Persisted wall-clock milliseconds.
 * @returns {{
 *   startAttempt(input: {organizationId: string|number, priceId: string}): {attemptId: string, idempotencyKey: string, state: 'pending', reused: boolean},
 *   markProviderSucceeded(input: {attemptId: string, providerSessionId: string}): void,
 *   markProviderFailed(input: {attemptId: string}): void
 * }} Checkout-attempt persistence port.
 */
export function createSqliteBillingCheckoutAttemptRepository(
  database,
  { randomUUID = systemRandomUUID, now = Date.now } = {},
) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite prepare/exec operations');
  }
  if (typeof randomUUID !== 'function') throw new TypeError('randomUUID must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  let preparedStatements;
  const statements = () => {
    if (preparedStatements) return preparedStatements;
    preparedStatements = {
      selectUnresolved: database.prepare(`
        SELECT attempt_id, idempotency_key, attempt_state, created_at_ms
        FROM billing_checkout_attempts
        WHERE organization_id = ?
          AND price_id = ?
          AND attempt_state IN ('pending','reconciliation_required')
        LIMIT 1
      `),
      requireReconciliation: database.prepare(`
        UPDATE billing_checkout_attempts
        SET attempt_state = 'reconciliation_required', updated_at_ms = ?
        WHERE attempt_id = ? AND attempt_state = 'pending'
      `),
      insertAttempt: database.prepare(`
        INSERT INTO billing_checkout_attempts(
          attempt_id, organization_id, price_id, idempotency_key,
          attempt_state, provider_session_id, created_at_ms, updated_at_ms
        ) VALUES(?,?,?,?, 'pending', NULL, ?, ?)
      `),
      succeedAttempt: database.prepare(`
        UPDATE billing_checkout_attempts
        SET attempt_state = 'provider_succeeded', provider_session_id = ?, updated_at_ms = ?
        WHERE attempt_id = ? AND attempt_state = 'pending'
      `),
      failAttempt: database.prepare(`
        UPDATE billing_checkout_attempts
        SET attempt_state = 'provider_failed', updated_at_ms = ?
        WHERE attempt_id = ? AND attempt_state = 'pending'
      `),
    };
    return preparedStatements;
  };

  return {
    /**
     * Reuse a still-pending same-tenant/same-price identity only inside the safe
     * replay window. Stale, clock-ambiguous, or already-held attempts fail closed
     * for authoritative reconciliation and never mint a speculative fresh key.
     */
    startAttempt({ organizationId, priceId }) {
      const organization = positiveOrganizationId(organizationId);
      const price = boundedRequiredString(priceId, 'priceId', MAX_PRICE_ID_LENGTH);
      const nowMs = safeNow(now);
      const sql = statements();

      const result = withSavepoint(database, () => {
        const unresolved = sql.selectUnresolved.get(organization, price);
        if (unresolved) {
          if (unresolved.attempt_state === 'reconciliation_required') {
            return { reconciliationRequiredAttemptId: unresolved.attempt_id };
          }

          const createdAtMs = Number(unresolved.created_at_ms);
          const ageMs = nowMs - createdAtMs;
          if (ageMs >= 0 && ageMs < BILLING_CHECKOUT_REUSE_WINDOW_MS) {
            return {
              attemptId: unresolved.attempt_id,
              idempotencyKey: unresolved.idempotency_key,
              state: 'pending',
              reused: true,
            };
          }

          sql.requireReconciliation.run(
            Math.max(nowMs, createdAtMs),
            unresolved.attempt_id,
          );
          return { reconciliationRequiredAttemptId: unresolved.attempt_id };
        }

        const attemptId = opaqueIdentifier(randomUUID, 'attemptId');
        const idempotencyKey = opaqueIdentifier(randomUUID, 'idempotencyKey');
        sql.insertAttempt.run(attemptId, organization, price, idempotencyKey, nowMs, nowMs);
        return { attemptId, idempotencyKey, state: 'pending', reused: false };
      });

      if (result.reconciliationRequiredAttemptId) {
        throw new BillingCheckoutReconciliationRequiredError(
          result.reconciliationRequiredAttemptId,
        );
      }
      return result;
    },

    /** Mark one unresolved attempt successful and bind its provider session ID. */
    markProviderSucceeded({ attemptId, providerSessionId }) {
      const id = boundedRequiredString(attemptId, 'attemptId', MAX_IDENTIFIER_LENGTH);
      const sessionId = boundedRequiredString(
        providerSessionId,
        'providerSessionId',
        MAX_PROVIDER_SESSION_ID_LENGTH,
      );
      const nowMs = safeNow(now);
      const result = withSavepoint(
        database,
        () => statements().succeedAttempt.run(sessionId, nowMs, id),
      );
      if (Number(result.changes) !== 1) {
        throw new Error('expected one pending checkout attempt for provider success');
      }
    },

    /** Mark one unresolved attempt as a known provider failure. */
    markProviderFailed({ attemptId }) {
      const id = boundedRequiredString(attemptId, 'attemptId', MAX_IDENTIFIER_LENGTH);
      const nowMs = safeNow(now);
      const result = withSavepoint(
        database,
        () => statements().failAttempt.run(nowMs, id),
      );
      if (Number(result.changes) !== 1) {
        throw new Error('expected one pending checkout attempt for provider failure');
      }
    },
  };
}
