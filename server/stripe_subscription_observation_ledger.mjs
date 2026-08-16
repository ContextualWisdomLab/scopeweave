const MAX_PROVIDER_ID_LENGTH = 255;
const MAX_SUBSCRIPTION_ITEMS = 100;
const SAVEPOINT_NAME = 'billing_stripe_subscription_observation_write';
const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const STRIPE_SUBSCRIPTION_STATUSES = new Set([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);

/** Stable fail-closed persistence error for authoritative Stripe observations. */
export class StripeSubscriptionObservationError extends Error {
  /**
   * @param {string} code stable machine-readable failure code
   * @param {number} status HTTP status suitable for a future service adapter
   */
  constructor(code, status = 400) {
    super(code);
    this.name = 'StripeSubscriptionObservationError';
    this.code = code;
    this.status = status;
  }
}

function observationError(code = 'stripe_subscription_observation_invalid', status = 400) {
  return new StripeSubscriptionObservationError(code, status);
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

function positiveOrganizationId(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw observationError();
  return parsed;
}

function nonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw observationError();
  return value;
}

function nullableTimestamp(value) {
  if (value == null) return null;
  return nonNegativeInteger(value);
}

function nullableIdentifier(value) {
  if (value == null) return null;
  return requiredIdentifier(value);
}

function sourceEventIdentifier(value) {
  if (value == null) return null;
  return requiredIdentifier(value);
}

function safeNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) throw observationError();
  return value;
}

function normalizedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw observationError();
  }

  const organizationId = positiveOrganizationId(snapshot.organizationId);
  const subscriptionId = requiredIdentifier(snapshot.subscriptionId);
  const customerId = requiredIdentifier(snapshot.customerId);
  if (!STRIPE_SUBSCRIPTION_STATUSES.has(snapshot.status)) throw observationError();
  if (typeof snapshot.cancelAtPeriodEnd !== 'boolean') throw observationError();

  const currentPeriodStartSec = nonNegativeInteger(snapshot.currentPeriodStartSec);
  const currentPeriodEndSec = nonNegativeInteger(snapshot.currentPeriodEndSec);
  if (currentPeriodEndSec < currentPeriodStartSec) throw observationError();

  if (!Array.isArray(snapshot.priceIds)
    || snapshot.priceIds.length === 0
    || snapshot.priceIds.length > MAX_SUBSCRIPTION_ITEMS) {
    throw observationError();
  }
  const priceIds = snapshot.priceIds.map(requiredIdentifier);

  return {
    organizationId,
    subscriptionId,
    customerId,
    status: snapshot.status,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    currentPeriodStartSec,
    currentPeriodEndSec,
    canceledAtSec: nullableTimestamp(snapshot.canceledAtSec),
    endedAtSec: nullableTimestamp(snapshot.endedAtSec),
    trialEndSec: nullableTimestamp(snapshot.trialEndSec),
    latestInvoiceId: nullableIdentifier(snapshot.latestInvoiceId),
    priceIds,
  };
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
 * Install normalized provider-identity and authoritative-observation relations.
 *
 * Customer, Subscription, and Price identifiers are stored once. Every provider
 * read is then appended as a separate immutable observation, with its ordered
 * price membership stored in a junction relation. The observation deliberately
 * does not contain organization plan or entitlement state: a separate policy
 * layer must decide whether provider facts authorize a local transition.
 *
 * This schema must be installed after `billing_stripe_webhook_events` when source
 * event provenance is available. Installation belongs to bootstrap/migrations,
 * never a request handler.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped database
 * @returns {void}
 */
export function installStripeSubscriptionObservationSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS billing_stripe_customers (
      customer_id TEXT PRIMARY KEY CHECK(length(customer_id) BETWEEN 1 AND ${MAX_PROVIDER_ID_LENGTH}),
      organization_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      first_observed_at_ms INTEGER NOT NULL CHECK(first_observed_at_ms >= 0)
    );
    CREATE INDEX IF NOT EXISTS billing_stripe_customer_organizations
      ON billing_stripe_customers(organization_id, customer_id);

    CREATE TABLE IF NOT EXISTS billing_stripe_subscriptions (
      subscription_id TEXT PRIMARY KEY CHECK(length(subscription_id) BETWEEN 1 AND ${MAX_PROVIDER_ID_LENGTH}),
      customer_id TEXT NOT NULL REFERENCES billing_stripe_customers(customer_id) ON DELETE CASCADE,
      first_observed_at_ms INTEGER NOT NULL CHECK(first_observed_at_ms >= 0)
    );
    CREATE INDEX IF NOT EXISTS billing_stripe_customer_subscriptions
      ON billing_stripe_subscriptions(customer_id, subscription_id);

    CREATE TABLE IF NOT EXISTS billing_stripe_prices (
      price_id TEXT PRIMARY KEY CHECK(length(price_id) BETWEEN 1 AND ${MAX_PROVIDER_ID_LENGTH}),
      first_observed_at_ms INTEGER NOT NULL CHECK(first_observed_at_ms >= 0)
    );

    CREATE TABLE IF NOT EXISTS billing_stripe_subscription_observations (
      observation_id INTEGER PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES billing_stripe_subscriptions(subscription_id) ON DELETE CASCADE,
      source_event_id TEXT REFERENCES billing_stripe_webhook_events(event_id) ON DELETE RESTRICT,
      observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
      subscription_status TEXT NOT NULL CHECK(subscription_status IN (
        'incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused'
      )),
      cancel_at_period_end INTEGER NOT NULL CHECK(cancel_at_period_end IN (0,1)),
      current_period_start_sec INTEGER NOT NULL CHECK(current_period_start_sec >= 0),
      current_period_end_sec INTEGER NOT NULL CHECK(current_period_end_sec >= current_period_start_sec),
      canceled_at_sec INTEGER CHECK(canceled_at_sec IS NULL OR canceled_at_sec >= 0),
      ended_at_sec INTEGER CHECK(ended_at_sec IS NULL OR ended_at_sec >= 0),
      trial_end_sec INTEGER CHECK(trial_end_sec IS NULL OR trial_end_sec >= 0),
      latest_invoice_id TEXT CHECK(latest_invoice_id IS NULL OR length(latest_invoice_id) BETWEEN 1 AND ${MAX_PROVIDER_ID_LENGTH})
    );
    CREATE INDEX IF NOT EXISTS billing_stripe_subscription_observation_history
      ON billing_stripe_subscription_observations(subscription_id, observed_at_ms, observation_id);
    CREATE INDEX IF NOT EXISTS billing_stripe_source_event_observations
      ON billing_stripe_subscription_observations(source_event_id, observation_id);

    CREATE TABLE IF NOT EXISTS billing_stripe_subscription_observation_prices (
      observation_id INTEGER NOT NULL REFERENCES billing_stripe_subscription_observations(observation_id) ON DELETE CASCADE,
      position_index INTEGER NOT NULL CHECK(position_index >= 0),
      price_id TEXT NOT NULL REFERENCES billing_stripe_prices(price_id) ON DELETE RESTRICT,
      PRIMARY KEY(observation_id, position_index)
    );
    CREATE INDEX IF NOT EXISTS billing_stripe_price_observations
      ON billing_stripe_subscription_observation_prices(price_id, observation_id);
  `);
}

/**
 * Create the SQLite persistence port for authoritative Stripe Subscription reads.
 *
 * A provider identifier is permanently bound to the first tenant/customer seen;
 * later attempts to rebind the same Stripe Customer or Subscription fail closed.
 * Successful reads append observations instead of overwriting previous evidence.
 * A caller may link an observation to a previously verified webhook event, but
 * that provenance never grants entitlement and is never used as an ordering key.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped database
 * @param {object} [dependencies] deterministic dependency seams
 * @param {() => number} [dependencies.now] wall-clock milliseconds
 * @returns {{recordAuthoritativeObservation(input: {snapshot: Record<string, unknown>, sourceEventId?: string|null}): Readonly<{observationId: number, subscriptionId: string, observedAtMs: number}>}}
 */
export function createSqliteStripeSubscriptionObservationRepository(database, { now = Date.now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite prepare/exec operations');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const selectOrganization = database.prepare('SELECT id FROM orgs WHERE id = ?');
  const selectSourceEvent = database.prepare(
    'SELECT event_id FROM billing_stripe_webhook_events WHERE event_id = ?',
  );
  const selectCustomer = database.prepare(
    'SELECT organization_id FROM billing_stripe_customers WHERE customer_id = ?',
  );
  const insertCustomer = database.prepare(`
    INSERT INTO billing_stripe_customers(customer_id, organization_id, first_observed_at_ms)
    VALUES(?,?,?)
  `);
  const selectSubscription = database.prepare(
    'SELECT customer_id FROM billing_stripe_subscriptions WHERE subscription_id = ?',
  );
  const insertSubscription = database.prepare(`
    INSERT INTO billing_stripe_subscriptions(subscription_id, customer_id, first_observed_at_ms)
    VALUES(?,?,?)
  `);
  const selectLastObserved = database.prepare(`
    SELECT MAX(observed_at_ms) AS observed_at_ms
    FROM billing_stripe_subscription_observations
    WHERE subscription_id = ?
  `);
  const insertPrice = database.prepare(`
    INSERT OR IGNORE INTO billing_stripe_prices(price_id, first_observed_at_ms)
    VALUES(?,?)
  `);
  const insertObservation = database.prepare(`
    INSERT INTO billing_stripe_subscription_observations(
      subscription_id, source_event_id, observed_at_ms, subscription_status,
      cancel_at_period_end, current_period_start_sec, current_period_end_sec,
      canceled_at_sec, ended_at_sec, trial_end_sec, latest_invoice_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertObservationPrice = database.prepare(`
    INSERT INTO billing_stripe_subscription_observation_prices(
      observation_id, position_index, price_id
    ) VALUES(?,?,?)
  `);

  return {
    /** Append one validated provider snapshot without making an entitlement decision. */
    recordAuthoritativeObservation({ snapshot, sourceEventId = null }) {
      const normalized = normalizedSnapshot(snapshot);
      const sourceEvent = sourceEventIdentifier(sourceEventId);
      const clockMs = safeNow(now);

      return withSavepoint(database, () => {
        if (!selectOrganization.get(normalized.organizationId)) {
          throw observationError('stripe_subscription_observation_invalid');
        }
        if (sourceEvent && !selectSourceEvent.get(sourceEvent)) {
          throw observationError('stripe_subscription_source_event_unknown', 409);
        }

        const existingCustomer = selectCustomer.get(normalized.customerId);
        if (existingCustomer) {
          if (Number(existingCustomer.organization_id) !== normalized.organizationId) {
            throw observationError('stripe_subscription_identity_conflict', 409);
          }
        } else {
          insertCustomer.run(normalized.customerId, normalized.organizationId, clockMs);
        }

        const existingSubscription = selectSubscription.get(normalized.subscriptionId);
        if (existingSubscription) {
          if (existingSubscription.customer_id !== normalized.customerId) {
            throw observationError('stripe_subscription_identity_conflict', 409);
          }
        } else {
          insertSubscription.run(normalized.subscriptionId, normalized.customerId, clockMs);
        }

        const priorObserved = selectLastObserved.get(normalized.subscriptionId)?.observed_at_ms;
        const observedAtMs = Number.isSafeInteger(priorObserved)
          ? Math.max(clockMs, priorObserved)
          : clockMs;

        for (const priceId of normalized.priceIds) {
          insertPrice.run(priceId, observedAtMs);
        }

        const observation = insertObservation.run(
          normalized.subscriptionId,
          sourceEvent,
          observedAtMs,
          normalized.status,
          normalized.cancelAtPeriodEnd ? 1 : 0,
          normalized.currentPeriodStartSec,
          normalized.currentPeriodEndSec,
          normalized.canceledAtSec,
          normalized.endedAtSec,
          normalized.trialEndSec,
          normalized.latestInvoiceId,
        );
        const observationId = Number(observation.lastInsertRowid);
        normalized.priceIds.forEach((priceId, positionIndex) => {
          insertObservationPrice.run(observationId, positionIndex, priceId);
        });

        return Object.freeze({
          observationId,
          subscriptionId: normalized.subscriptionId,
          observedAtMs,
        });
      });
    },
  };
}
