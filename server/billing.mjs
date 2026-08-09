import { randomUUID } from 'node:crypto';

// Billing / plan configuration + checkout. Stripe requests are sent directly
// from the trusted server boundary after complete credentials are present. Mock
// checkout is confined to SCOPEWEAVE_DEV=1. Plan changes remain server-side.

export const PLANS = {
  free: { name: 'Free', limits: { projects: 2, members: 3 }, priceKrw: 0 },
  pro: { name: 'Pro', limits: { projects: null, members: null }, priceKrw: 19000 }, // null = unlimited
};

export function planOf(org) {
  return PLANS[org?.plan] || PLANS.free;
}

// Returns { projects, members } counts for an org.
export function orgUsage(db, orgId) {
  const projects = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE org_id = ?').get(orgId).n;
  const members = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?').get(orgId).n;
  return { projects, members };
}

// true if adding one more of `kind` would exceed the org's plan limit.
export function wouldExceed(db, org, kind) {
  const limit = planOf(org).limits[kind];
  if (limit == null) return false; // unlimited
  return orgUsage(db, org.id)[kind] >= limit;
}

/** Error raised when production billing cannot be configured or completed safely. */
export class BillingConfigurationError extends Error {
  /**
   * Create one stable billing configuration error.
   * @param {string} code machine-readable failure code
   * @param {string} message operator-safe failure detail
   */
  constructor(code, message) {
    super(message);
    this.name = 'BillingConfigurationError';
    this.code = code;
  }
}

/**
 * Resolve the complete Stripe Checkout configuration or the explicit dev-only mock boundary.
 * @returns {{secretKey: string, priceId: string} | null}
 */
function stripeCheckoutConfiguration() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const priceId = String(process.env.STRIPE_PRICE_ID || '').trim();
  if (!secretKey && !priceId) {
    if (process.env.SCOPEWEAVE_DEV === '1') return null;
    throw new BillingConfigurationError(
      'billing_not_configured',
      'Stripe checkout is unavailable because billing credentials are not configured.',
    );
  }
  if (!secretKey || !priceId) {
    throw new BillingConfigurationError(
      'billing_configuration_incomplete',
      'Stripe checkout requires both STRIPE_SECRET_KEY and STRIPE_PRICE_ID.',
    );
  }
  return { secretKey, priceId };
}

/**
 * Parse a bounded Stripe response without exposing provider payloads in errors.
 * @param {Response} response provider response
 * @returns {Promise<Record<string, unknown>>}
 */
async function stripeResponseJson(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new BillingConfigurationError(
      'billing_provider_invalid_response',
      'Stripe returned a non-JSON Checkout response.',
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BillingConfigurationError(
      'billing_provider_invalid_response',
      'Stripe returned an invalid Checkout response.',
    );
  }
  return payload;
}

/**
 * Create a production Stripe Checkout Session.
 *
 * A mock URL is returned only under the explicit `SCOPEWEAVE_DEV=1`
 * development boundary; an unconfigured production process fails closed.
 *
 * @param {{orgId: string | number, origin: string, fetchImpl?: typeof fetch, idempotencyKey?: string}} checkoutContext checkout identity
 * @returns {Promise<{url: string, live: boolean, mock?: boolean}>}
 */
export async function createCheckout({
  orgId,
  origin,
  fetchImpl = globalThis.fetch,
  idempotencyKey = `scopeweave-checkout-${orgId}-${randomUUID()}`,
}) {
  const configuration = stripeCheckoutConfiguration();
  if (!configuration) {
    return { url: `${origin}/?billing=mock&org=${orgId}`, live: false, mock: true };
  }
  if (typeof fetchImpl !== 'function') {
    throw new BillingConfigurationError(
      'billing_transport_unavailable',
      'Stripe checkout transport is unavailable.',
    );
  }

  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': configuration.priceId,
    'line_items[0][quantity]': '1',
    success_url: `${origin}/?billing=success`,
    cancel_url: `${origin}/?billing=cancel`,
    client_reference_id: String(orgId),
    'metadata[orgId]': String(orgId),
    'subscription_data[metadata][orgId]': String(orgId),
  });
  let response;
  try {
    response = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${configuration.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': idempotencyKey,
        'stripe-version': '2026-02-25.clover',
      },
      body: form.toString(),
    });
  } catch {
    throw new BillingConfigurationError(
      'billing_provider_unavailable',
      'Stripe Checkout could not be reached.',
    );
  }

  const payload = await stripeResponseJson(response);
  if (!response.ok) {
    throw new BillingConfigurationError(
      'billing_provider_rejected',
      `Stripe Checkout rejected the request with HTTP ${response.status}.`,
    );
  }
  if (typeof payload.url !== 'string' || !payload.url.startsWith('https://checkout.stripe.com/')) {
    throw new BillingConfigurationError(
      'billing_provider_invalid_response',
      'Stripe did not return a trusted Checkout Session URL.',
    );
  }
  return { url: payload.url, live: true };
}
