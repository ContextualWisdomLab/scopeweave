const MAX_PROVIDER_ID_LENGTH = 255;
const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const CANONICAL_ORGANIZATION_ID_PATTERN = /^[1-9][0-9]*$/u;

function positiveOrganizationId(value) {
  if (typeof value === 'string' && !CANONICAL_ORGANIZATION_ID_PATTERN.test(value)) {
    throw new TypeError('organizationId must be a positive safe integer');
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError('organizationId must be a positive safe integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError('organizationId must be a positive safe integer');
  }
  return parsed;
}

function requiredInvoiceId(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || !PROVIDER_IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError('invoiceId must be a bounded Stripe identifier');
  }
  return value;
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

function freezeProjection(row) {
  return Object.freeze({
    observationId: Number(row.observation_id),
    observedAtMs: Number(row.observed_at_ms),
    organizationId: Number(row.organization_id),
    customerId: row.customer_id,
    subscriptionId: row.subscription_id,
    invoiceId: row.invoice_id,
    sourceSubscriptionObservationId: Number(row.source_subscription_observation_id),
    sourceEventId: row.source_event_id ?? null,
    status: row.invoice_status,
    paid: Number(row.paid) === 1,
    currency: row.currency_code,
    amountDue: Number(row.amount_due_minor),
    amountPaid: Number(row.amount_paid_minor),
    amountRemaining: Number(row.amount_remaining_minor),
    createdSec: Number(row.provider_created_at_sec),
    paidAtSec: row.paid_at_sec == null ? null : Number(row.paid_at_sec),
  });
}

/**
 * Create a tenant-scoped read-only projection over accepted authoritative Stripe
 * Invoice observations.
 *
 * Current state is selected by append-only observation identity rather than
 * webhook arrival time, provider creation time, or mutable wall-clock values.
 * Every row was already linked to an accepted Subscription observation and is
 * re-scoped through Subscription -> Customer -> organization on read. The
 * projection never mutates plan or entitlement state.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped database
 * @returns {{
 *   getCurrentInvoice(input: {organizationId: number|string, invoiceId: string}): Readonly<Record<string, unknown>>|null,
 *   listCurrentInvoices(input: {organizationId: number|string, subscriptionId?: string|null}): readonly Readonly<Record<string, unknown>>[]
 * }} tenant-scoped immutable Invoice projection
 */
export function createSqliteStripeInvoiceCurrentProjection(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('database must provide SQLite prepare operations');
  }

  const selectCurrentInvoice = database.prepare(`
    SELECT
      observations.observation_id,
      observations.observed_at_ms,
      customers.organization_id,
      subscriptions.customer_id,
      invoices.subscription_id,
      observations.invoice_id,
      observations.source_subscription_observation_id,
      observations.source_event_id,
      observations.invoice_status,
      observations.paid,
      observations.currency_code,
      observations.amount_due_minor,
      observations.amount_paid_minor,
      observations.amount_remaining_minor,
      observations.provider_created_at_sec,
      observations.paid_at_sec
    FROM billing_stripe_invoice_observations AS observations
    JOIN billing_stripe_invoices AS invoices
      ON invoices.invoice_id = observations.invoice_id
    JOIN billing_stripe_subscriptions AS subscriptions
      ON subscriptions.subscription_id = invoices.subscription_id
    JOIN billing_stripe_customers AS customers
      ON customers.customer_id = subscriptions.customer_id
    WHERE customers.organization_id = ?
      AND observations.invoice_id = ?
    ORDER BY observations.observation_id DESC
    LIMIT 1
  `);

  const selectCurrentInvoices = database.prepare(`
    SELECT
      observations.observation_id,
      observations.observed_at_ms,
      customers.organization_id,
      subscriptions.customer_id,
      invoices.subscription_id,
      observations.invoice_id,
      observations.source_subscription_observation_id,
      observations.source_event_id,
      observations.invoice_status,
      observations.paid,
      observations.currency_code,
      observations.amount_due_minor,
      observations.amount_paid_minor,
      observations.amount_remaining_minor,
      observations.provider_created_at_sec,
      observations.paid_at_sec
    FROM billing_stripe_invoice_observations AS observations
    JOIN (
      SELECT invoice_id, MAX(observation_id) AS observation_id
      FROM billing_stripe_invoice_observations
      GROUP BY invoice_id
    ) AS current_observations
      ON current_observations.observation_id = observations.observation_id
    JOIN billing_stripe_invoices AS invoices
      ON invoices.invoice_id = observations.invoice_id
    JOIN billing_stripe_subscriptions AS subscriptions
      ON subscriptions.subscription_id = invoices.subscription_id
    JOIN billing_stripe_customers AS customers
      ON customers.customer_id = subscriptions.customer_id
    WHERE customers.organization_id = ?
      AND (? IS NULL OR invoices.subscription_id = ?)
    ORDER BY observations.invoice_id ASC
  `);

  return Object.freeze({
    /** Return the latest accepted observation for one tenant-owned Invoice. */
    getCurrentInvoice({ organizationId, invoiceId }) {
      const normalizedOrganizationId = positiveOrganizationId(organizationId);
      const normalizedInvoiceId = requiredInvoiceId(invoiceId);
      const row = selectCurrentInvoice.get(normalizedOrganizationId, normalizedInvoiceId);
      return row ? freezeProjection(row) : null;
    },

    /** Return one latest accepted observation per Invoice, optionally for one Subscription. */
    listCurrentInvoices({ organizationId, subscriptionId = null }) {
      const normalizedOrganizationId = positiveOrganizationId(organizationId);
      const normalizedSubscriptionId = subscriptionId == null ? null : requiredSubscriptionId(subscriptionId);
      const rows = selectCurrentInvoices.all(
        normalizedOrganizationId,
        normalizedSubscriptionId,
        normalizedSubscriptionId,
      );
      return Object.freeze(rows.map(freezeProjection));
    },
  });
}
