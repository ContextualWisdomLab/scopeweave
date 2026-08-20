const MAX_PROVIDER_ID_LENGTH = 255;
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/u;
const SAVEPOINT_NAME = 'billing_stripe_reconciliation_trigger_write';

/** Stable fail-closed error for verified-webhook reconciliation trigger handling. */
export class StripeWebhookReconciliationQueueError extends Error {
  /**
   * Create one sanitized reconciliation-trigger failure.
   * @param {string} code stable machine-readable failure code
   * @param {number} [status=400] HTTP-compatible status for an adapter
   */
  constructor(code, status = 400) {
    super(code);
    this.name = 'StripeWebhookReconciliationQueueError';
    this.code = code;
    this.status = status;
  }
}

function queueError(code, status = 400) {
  return new StripeWebhookReconciliationQueueError(code, status);
}

function requiredBoundedString(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw queueError('stripe_reconciliation_trigger_invalid');
  }
  return value;
}

function normalizedSubscriptionId(value) {
  const subscriptionId = requiredBoundedString(value);
  if (!SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) {
    throw queueError('stripe_reconciliation_trigger_invalid');
  }
  return subscriptionId;
}

function optionalSubscriptionId(value) {
  if (value == null) return null;
  return normalizedSubscriptionId(value);
}

function normalizedNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw queueError('stripe_reconciliation_trigger_invalid');
  }
  return value;
}

function requireEventEnvelope(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw queueError('stripe_reconciliation_trigger_invalid');
  }
  const type = requiredBoundedString(event.type);
  const object = event.data?.object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw queueError('stripe_reconciliation_trigger_invalid');
  }
  return { type, object };
}

function currentInvoiceSubscription(object) {
  if (object.parent == null) return null;
  if (typeof object.parent !== 'object' || Array.isArray(object.parent)) {
    throw queueError('stripe_reconciliation_trigger_invalid');
  }
  if (object.parent.type !== 'subscription_details') return null;
  const details = object.parent.subscription_details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw queueError('stripe_reconciliation_trigger_invalid');
  }
  return optionalSubscriptionId(details.subscription);
}

/**
 * Extract the Subscription identity that a verified Stripe event should reconcile.
 *
 * The returned identifier is only a trigger key. It is never treated as current
 * lifecycle or entitlement authority; the reconciliation service must re-fetch
 * current provider state before evaluating durable claims. Irrelevant events and
 * one-off invoices return `null`. Contradictory current/legacy Invoice provenance
 * fails closed instead of selecting one representation.
 *
 * @param {Record<string, unknown>} event cryptographically verified Stripe event
 * @returns {string|null} bounded Subscription identity to reconcile
 * @throws {StripeWebhookReconciliationQueueError} for malformed relevant events
 */
export function extractStripeSubscriptionReconciliationCandidate(event) {
  const { type, object } = requireEventEnvelope(event);

  if (type.startsWith('customer.subscription.')) {
    if (object.object !== 'subscription') {
      throw queueError('stripe_reconciliation_trigger_invalid');
    }
    return normalizedSubscriptionId(object.id);
  }

  if (!type.startsWith('invoice.')) return null;
  if (object.object !== 'invoice') {
    throw queueError('stripe_reconciliation_trigger_invalid');
  }

  const current = currentInvoiceSubscription(object);
  const legacy = optionalSubscriptionId(object.subscription);
  if (current && legacy && current !== legacy) {
    throw queueError('stripe_reconciliation_trigger_invalid');
  }
  return current || legacy || null;
}

/**
 * Install the normalized verified-webhook reconciliation trigger relation.
 *
 * One verified Stripe Event may create at most one durable reconciliation trigger.
 * Re-delivery therefore remains idempotent while a conflicting attempt to bind the
 * same event identity to a different Subscription fails closed. Processing is a
 * later worker concern; this slice records only pending work.
 *
 * @param {import('node:sqlite').DatabaseSync} database open SQLite database
 * @returns {void}
 */
export function installStripeWebhookReconciliationQueueSchema(database) {
  if (!database || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite exec operations');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS billing_stripe_reconciliation_triggers (
      event_id TEXT PRIMARY KEY
        REFERENCES billing_stripe_webhook_events(event_id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL
        CHECK(length(subscription_id) BETWEEN 5 AND ${MAX_PROVIDER_ID_LENGTH}),
      queued_at_ms INTEGER NOT NULL CHECK(queued_at_ms >= 0),
      processing_state TEXT NOT NULL DEFAULT 'pending'
        CHECK(processing_state = 'pending')
    );
    CREATE INDEX IF NOT EXISTS billing_stripe_reconciliation_pending_triggers
      ON billing_stripe_reconciliation_triggers(processing_state, queued_at_ms, event_id);
  `);
}

/**
 * Create the durable queue port for already-verified Stripe webhook events.
 *
 * The constructor never creates schema. `enqueue` first proves the event identity
 * already exists in the verified-event ledger, then appends one pending trigger.
 * Exact replay is idempotent; event-to-Subscription rebinding is rejected.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped SQLite database
 * @param {object} [dependencies] deterministic test seams
 * @param {() => number} [dependencies.now] wall-clock milliseconds
 * @returns {{enqueue(input: {eventId: string, subscriptionId: string}): Readonly<{eventId: string, subscriptionId: string, queued: boolean}>}}
 */
export function createSqliteStripeWebhookReconciliationQueue(database, { now = Date.now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite prepare/exec operations');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const selectVerifiedEvent = database.prepare(`
    SELECT event_id FROM billing_stripe_webhook_events WHERE event_id = ?
  `);
  const selectTrigger = database.prepare(`
    SELECT subscription_id FROM billing_stripe_reconciliation_triggers WHERE event_id = ?
  `);
  const insertTrigger = database.prepare(`
    INSERT INTO billing_stripe_reconciliation_triggers(
      event_id, subscription_id, queued_at_ms, processing_state
    ) VALUES(?,?,?,'pending')
  `);

  return Object.freeze({
    /** Persist one idempotent pending trigger for a verified provider event. */
    enqueue({ eventId, subscriptionId } = {}) {
      const normalizedEventId = requiredBoundedString(eventId);
      const normalizedSubscription = normalizedSubscriptionId(subscriptionId);

      database.exec(`SAVEPOINT ${SAVEPOINT_NAME}`);
      try {
        const existing = selectTrigger.get(normalizedEventId);
        if (existing) {
          if (existing.subscription_id !== normalizedSubscription) {
            throw queueError('stripe_reconciliation_trigger_conflict', 409);
          }
          database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
          return Object.freeze({
            eventId: normalizedEventId,
            subscriptionId: normalizedSubscription,
            queued: false,
          });
        }

        if (!selectVerifiedEvent.get(normalizedEventId)) {
          throw queueError('stripe_reconciliation_trigger_unverified', 409);
        }

        const queuedAtMs = normalizedNow(now);
        insertTrigger.run(normalizedEventId, normalizedSubscription, queuedAtMs);
        database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
        return Object.freeze({
          eventId: normalizedEventId,
          subscriptionId: normalizedSubscription,
          queued: true,
        });
      } catch (error) {
        let rollbackSucceeded = false;
        try {
          database.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
          rollbackSucceeded = true;
        } catch {
          // Keep an unconfirmed failed savepoint open instead of risking commit.
        }
        if (rollbackSucceeded) {
          try {
            database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
          } catch {
            // Cleanup after confirmed rollback must not replace causal failure.
          }
        }
        throw error;
      }
    },
  });
}
