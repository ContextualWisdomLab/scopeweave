const MAX_PROVIDER_ID_LENGTH = 255;
const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:-]+$/u;

function positiveOrganizationId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError('organizationId must be a positive safe integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError('organizationId must be a positive safe integer');
  }
  return parsed;
}

function requiredSubscriptionId(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || !PROVIDER_IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError('subscriptionId must be a bounded Stripe identifier');
  }
  return value;
}

function freezeProjection(row, priceIds) {
  return Object.freeze({
    observationId: Number(row.observation_id),
    observedAtMs: Number(row.observed_at_ms),
    organizationId: Number(row.organization_id),
    customerId: row.customer_id,
    subscriptionId: row.subscription_id,
    status: row.subscription_status,
    cancelAtPeriodEnd: Number(row.cancel_at_period_end) === 1,
    currentPeriodStartSec: Number(row.current_period_start_sec),
    currentPeriodEndSec: Number(row.current_period_end_sec),
    canceledAtSec: row.canceled_at_sec == null ? null : Number(row.canceled_at_sec),
    endedAtSec: row.ended_at_sec == null ? null : Number(row.ended_at_sec),
    trialEndSec: row.trial_end_sec == null ? null : Number(row.trial_end_sec),
    latestInvoiceId: row.latest_invoice_id ?? null,
    sourceEventId: row.source_event_id ?? null,
    priceIds: Object.freeze(priceIds),
  });
}

/**
 * Create a read-only projection over accepted authoritative Stripe observations.
 *
 * The projection deliberately orders by the append-only observation identifier,
 * not webhook delivery time. A webhook can arrive out of order, while every row
 * represented here has already passed the tenant/customer/subscription binding
 * checks in the authoritative observation repository. Reads are always scoped by
 * the local organization identifier and never mutate `orgs.plan` or any other
 * entitlement state.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped database
 * @returns {{
 *   getCurrentSubscription(input: {organizationId: number|string, subscriptionId: string}): Readonly<Record<string, unknown>>|null,
 *   listCurrentSubscriptions(input: {organizationId: number|string}): readonly Readonly<Record<string, unknown>>[]
 * }} tenant-scoped immutable current-state projection
 */
export function createSqliteStripeSubscriptionCurrentProjection(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('database must provide SQLite prepare operations');
  }

  const selectCurrentSubscription = database.prepare(`
    SELECT
      observations.observation_id,
      observations.observed_at_ms,
      customers.organization_id,
      subscriptions.customer_id,
      observations.subscription_id,
      observations.subscription_status,
      observations.cancel_at_period_end,
      observations.current_period_start_sec,
      observations.current_period_end_sec,
      observations.canceled_at_sec,
      observations.ended_at_sec,
      observations.trial_end_sec,
      observations.latest_invoice_id,
      observations.source_event_id
    FROM billing_stripe_subscription_observations AS observations
    JOIN billing_stripe_subscriptions AS subscriptions
      ON subscriptions.subscription_id = observations.subscription_id
    JOIN billing_stripe_customers AS customers
      ON customers.customer_id = subscriptions.customer_id
    WHERE customers.organization_id = ?
      AND observations.subscription_id = ?
    ORDER BY observations.observation_id DESC
    LIMIT 1
  `);

  const selectCurrentSubscriptions = database.prepare(`
    SELECT
      observations.observation_id,
      observations.observed_at_ms,
      customers.organization_id,
      subscriptions.customer_id,
      observations.subscription_id,
      observations.subscription_status,
      observations.cancel_at_period_end,
      observations.current_period_start_sec,
      observations.current_period_end_sec,
      observations.canceled_at_sec,
      observations.ended_at_sec,
      observations.trial_end_sec,
      observations.latest_invoice_id,
      observations.source_event_id
    FROM billing_stripe_subscription_observations AS observations
    JOIN (
      SELECT subscription_id, MAX(observation_id) AS observation_id
      FROM billing_stripe_subscription_observations
      GROUP BY subscription_id
    ) AS current_observations
      ON current_observations.observation_id = observations.observation_id
    JOIN billing_stripe_subscriptions AS subscriptions
      ON subscriptions.subscription_id = observations.subscription_id
    JOIN billing_stripe_customers AS customers
      ON customers.customer_id = subscriptions.customer_id
    WHERE customers.organization_id = ?
    ORDER BY observations.subscription_id ASC
  `);

  const selectObservationPrices = database.prepare(`
    SELECT price_id
    FROM billing_stripe_subscription_observation_prices
    WHERE observation_id = ?
    ORDER BY position_index ASC
  `);

  function projectRow(row) {
    const priceIds = selectObservationPrices.all(row.observation_id).map(({ price_id: priceId }) => priceId);
    return freezeProjection(row, priceIds);
  }

  return Object.freeze({
    /** Return the latest accepted observation for one tenant-owned subscription. */
    getCurrentSubscription({ organizationId, subscriptionId }) {
      const normalizedOrganizationId = positiveOrganizationId(organizationId);
      const normalizedSubscriptionId = requiredSubscriptionId(subscriptionId);
      const row = selectCurrentSubscription.get(normalizedOrganizationId, normalizedSubscriptionId);
      return row ? projectRow(row) : null;
    },

    /** Return one latest accepted observation per subscription owned by a tenant. */
    listCurrentSubscriptions({ organizationId }) {
      const normalizedOrganizationId = positiveOrganizationId(organizationId);
      const rows = selectCurrentSubscriptions.all(normalizedOrganizationId);
      return Object.freeze(rows.map(projectRow));
    },
  });
}
