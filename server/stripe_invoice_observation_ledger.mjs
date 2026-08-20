const MAX_PROVIDER_ID_LENGTH = 255;
const SAVEPOINT_NAME = 'billing_stripe_invoice_observation_write';
const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const CURRENCY_PATTERN = /^[a-z]{3}$/u;
const INVOICE_STATUSES = new Set(['draft', 'open', 'paid', 'uncollectible', 'void']);

/** Stable fail-closed persistence error for authoritative Stripe Invoice observations. */
export class StripeInvoiceObservationError extends Error {
  /**
   * @param {string} code stable machine-readable failure code
   * @param {number} status HTTP status suitable for a future service adapter
   */
  constructor(code, status = 400) {
    super(code);
    this.name = 'StripeInvoiceObservationError';
    this.code = code;
    this.status = status;
  }
}

function observationError(code = 'stripe_invoice_observation_invalid', status = 400) {
  return new StripeInvoiceObservationError(code, status);
}

function requiredIdentifier(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || !PROVIDER_IDENTIFIER_PATTERN.test(value)) {
    throw observationError();
  }
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw observationError();
  return value;
}

function nonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw observationError();
  return value;
}

function sourceEventIdentifier(value) {
  return value == null ? null : requiredIdentifier(value);
}

function safeNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) throw observationError();
  return value;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw observationError();
  const organizationId = positiveInteger(snapshot.organizationId);
  const invoiceId = requiredIdentifier(snapshot.invoiceId);
  const subscriptionId = requiredIdentifier(snapshot.subscriptionId);
  const customerId = requiredIdentifier(snapshot.customerId);
  if (!INVOICE_STATUSES.has(snapshot.status)) throw observationError();
  if (typeof snapshot.paid !== 'boolean' || snapshot.paid !== (snapshot.status === 'paid')) throw observationError();
  if (typeof snapshot.currency !== 'string' || !CURRENCY_PATTERN.test(snapshot.currency)) throw observationError();
  const paidAtSec = snapshot.paidAtSec == null ? null : nonNegativeInteger(snapshot.paidAtSec);
  if ((snapshot.status === 'paid') !== (paidAtSec !== null)) throw observationError();
  return {
    organizationId,
    invoiceId,
    subscriptionId,
    customerId,
    status: snapshot.status,
    paid: snapshot.paid,
    currency: snapshot.currency,
    amountDue: nonNegativeInteger(snapshot.amountDue),
    amountPaid: nonNegativeInteger(snapshot.amountPaid),
    amountRemaining: nonNegativeInteger(snapshot.amountRemaining),
    createdSec: nonNegativeInteger(snapshot.createdSec),
    paidAtSec,
  };
}

function withSavepoint(database, operation) {
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
      // Keep an unconfirmed failed savepoint open instead of risking partial commit.
    }
    if (rollbackSucceeded) {
      try {
        database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
      } catch {
        // Cleanup failure after a confirmed rollback never replaces the causal error.
      }
    }
    throw error;
  }
}

/**
 * Install normalized authoritative Stripe Invoice identity and observation relations.
 *
 * The Invoice identity is stored once and permanently bound to a Subscription.
 * Every accepted provider read is appended separately and references the exact
 * authoritative Subscription observation that named the Invoice. Payment facts
 * never share a row with tenant identity or entitlement policy, preserving 3NF
 * and keeping append-only evidence separate from authorization decisions.
 *
 * Installation belongs to bootstrap/migrations and must run after Subscription
 * observation and verified webhook-event schemas exist.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped database
 * @returns {void}
 */
export function installStripeInvoiceObservationSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS billing_stripe_invoices (
      invoice_id TEXT PRIMARY KEY CHECK(length(invoice_id) BETWEEN 1 AND ${MAX_PROVIDER_ID_LENGTH}),
      subscription_id TEXT NOT NULL REFERENCES billing_stripe_subscriptions(subscription_id) ON DELETE CASCADE,
      first_observed_at_ms INTEGER NOT NULL CHECK(first_observed_at_ms >= 0)
    );
    CREATE INDEX IF NOT EXISTS billing_stripe_subscription_invoices
      ON billing_stripe_invoices(subscription_id, invoice_id);

    CREATE TABLE IF NOT EXISTS billing_stripe_invoice_observations (
      observation_id INTEGER PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES billing_stripe_invoices(invoice_id) ON DELETE CASCADE,
      source_subscription_observation_id INTEGER NOT NULL
        REFERENCES billing_stripe_subscription_observations(observation_id) ON DELETE RESTRICT,
      source_event_id TEXT REFERENCES billing_stripe_webhook_events(event_id) ON DELETE RESTRICT,
      observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
      invoice_status TEXT NOT NULL CHECK(invoice_status IN ('draft','open','paid','uncollectible','void')),
      paid INTEGER NOT NULL CHECK(paid IN (0,1)),
      currency_code TEXT NOT NULL CHECK(length(currency_code) = 3),
      amount_due_minor INTEGER NOT NULL CHECK(amount_due_minor >= 0),
      amount_paid_minor INTEGER NOT NULL CHECK(amount_paid_minor >= 0),
      amount_remaining_minor INTEGER NOT NULL CHECK(amount_remaining_minor >= 0),
      provider_created_at_sec INTEGER NOT NULL CHECK(provider_created_at_sec >= 0),
      paid_at_sec INTEGER CHECK(paid_at_sec IS NULL OR paid_at_sec >= 0),
      CHECK((invoice_status = 'paid' AND paid = 1 AND paid_at_sec IS NOT NULL)
        OR (invoice_status <> 'paid' AND paid = 0 AND paid_at_sec IS NULL))
    );
    CREATE INDEX IF NOT EXISTS billing_stripe_invoice_observation_history
      ON billing_stripe_invoice_observations(invoice_id, observed_at_ms, observation_id);
    CREATE INDEX IF NOT EXISTS billing_stripe_invoice_subscription_sources
      ON billing_stripe_invoice_observations(source_subscription_observation_id, observation_id);
    CREATE INDEX IF NOT EXISTS billing_stripe_invoice_event_sources
      ON billing_stripe_invoice_observations(source_event_id, observation_id);
  `);
}

/**
 * Create the SQLite append-only repository for authoritative Stripe Invoice reads.
 *
 * The exact accepted Subscription observation is required as durable routing
 * authority. Its tenant, Customer, Subscription, and `latest_invoice_id` must
 * match the normalized Invoice snapshot before any Invoice identity or observation
 * can be stored. Rebinding one Invoice to another Subscription fails closed.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped database
 * @param {object} [dependencies] deterministic dependency seams
 * @param {() => number} [dependencies.now] wall-clock milliseconds
 * @returns {{recordAuthoritativeObservation(input: {snapshot: Record<string, unknown>, sourceSubscriptionObservationId: number, sourceEventId?: string|null}): Readonly<{observationId: number, invoiceId: string, observedAtMs: number, sourceSubscriptionObservationId: number}>}}
 */
export function createSqliteStripeInvoiceObservationRepository(database, { now = Date.now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite prepare/exec operations');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const selectSubscriptionAuthority = database.prepare(`
    SELECT o.observation_id, o.latest_invoice_id, s.subscription_id,
           c.customer_id, c.organization_id
    FROM billing_stripe_subscription_observations o
    JOIN billing_stripe_subscriptions s ON s.subscription_id = o.subscription_id
    JOIN billing_stripe_customers c ON c.customer_id = s.customer_id
    WHERE o.observation_id = ?
  `);
  const selectSourceEvent = database.prepare(
    'SELECT event_id FROM billing_stripe_webhook_events WHERE event_id = ?',
  );
  const selectInvoice = database.prepare(
    'SELECT subscription_id FROM billing_stripe_invoices WHERE invoice_id = ?',
  );
  const insertInvoice = database.prepare(`
    INSERT INTO billing_stripe_invoices(invoice_id, subscription_id, first_observed_at_ms)
    VALUES(?,?,?)
  `);
  const selectLastObserved = database.prepare(`
    SELECT MAX(observed_at_ms) AS observed_at_ms
    FROM billing_stripe_invoice_observations
    WHERE invoice_id = ?
  `);
  const insertObservation = database.prepare(`
    INSERT INTO billing_stripe_invoice_observations(
      invoice_id, source_subscription_observation_id, source_event_id,
      observed_at_ms, invoice_status, paid, currency_code,
      amount_due_minor, amount_paid_minor, amount_remaining_minor,
      provider_created_at_sec, paid_at_sec
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  return {
    /** Append one tenant-bound authoritative Invoice snapshot without granting entitlement. */
    recordAuthoritativeObservation({ snapshot, sourceSubscriptionObservationId, sourceEventId = null }) {
      const normalized = normalizeSnapshot(snapshot);
      const sourceObservation = positiveInteger(sourceSubscriptionObservationId);
      const sourceEvent = sourceEventIdentifier(sourceEventId);
      const clockMs = safeNow(now);

      return withSavepoint(database, () => {
        const authority = selectSubscriptionAuthority.get(sourceObservation);
        if (!authority) throw observationError('stripe_invoice_subscription_observation_unknown', 409);
        if (Number(authority.organization_id) !== normalized.organizationId
          || authority.customer_id !== normalized.customerId
          || authority.subscription_id !== normalized.subscriptionId
          || authority.latest_invoice_id !== normalized.invoiceId) {
          throw observationError('stripe_invoice_identity_conflict', 409);
        }
        if (sourceEvent && !selectSourceEvent.get(sourceEvent)) {
          throw observationError('stripe_invoice_source_event_unknown', 409);
        }

        const existingInvoice = selectInvoice.get(normalized.invoiceId);
        if (existingInvoice) {
          if (existingInvoice.subscription_id !== normalized.subscriptionId) {
            throw observationError('stripe_invoice_identity_conflict', 409);
          }
        } else {
          insertInvoice.run(normalized.invoiceId, normalized.subscriptionId, clockMs);
        }

        const priorObserved = selectLastObserved.get(normalized.invoiceId)?.observed_at_ms;
        const observedAtMs = Number.isSafeInteger(priorObserved)
          ? Math.max(clockMs, priorObserved)
          : clockMs;
        const observation = insertObservation.run(
          normalized.invoiceId,
          sourceObservation,
          sourceEvent,
          observedAtMs,
          normalized.status,
          normalized.paid ? 1 : 0,
          normalized.currency,
          normalized.amountDue,
          normalized.amountPaid,
          normalized.amountRemaining,
          normalized.createdSec,
          normalized.paidAtSec,
        );
        const observationId = Number(observation.lastInsertRowid);
        return Object.freeze({
          observationId,
          invoiceId: normalized.invoiceId,
          observedAtMs,
          sourceSubscriptionObservationId: sourceObservation,
        });
      });
    },
  };
}
