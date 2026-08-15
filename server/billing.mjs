// Billing / plan configuration + checkout. Stripe is optional at install time,
// but production never substitutes a missing provider with a successful mock.
// Plan changes only ever happen server-side.
import { HTTPException } from 'hono/http-exception';
import { validateBillingStartupConfiguration } from './billing_configuration.mjs';

const billingConfiguration = validateBillingStartupConfiguration();

export const PLANS = {
  free: { name: 'Free', limits: { projects: 2, members: 3 }, priceKrw: 0 },
  pro: { name: 'Pro', limits: { projects: null, members: null }, priceKrw: 19000 }, // null = unlimited
};

/** Return the effective plan definition for an organization-like record. */
export function planOf(org) {
  return PLANS[org?.plan] || PLANS.free;
}

/** Return current project/member counts for one organization. */
export function orgUsage(db, orgId) {
  const projects = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE org_id = ?').get(orgId).n;
  const members = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?').get(orgId).n;
  return { projects, members };
}

/** Return whether adding one resource would exceed the organization's plan limit. */
export function wouldExceed(db, org, kind) {
  const limit = planOf(org).limits[kind];
  if (limit == null) return false; // unlimited
  return orgUsage(db, org.id)[kind] >= limit;
}

function billingUnavailableResponse() {
  return new Response(JSON.stringify({
    error: 'billing_not_configured',
    action: 'Configure the complete Stripe billing settings and SCOPEWEAVE_PUBLIC_ORIGIN, then restart ScopeWeave.',
  }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

async function defaultStripeClientFactory(secretKey) {
  const { default: Stripe } = await import('stripe');
  return new Stripe(secretKey);
}

/**
 * Create one hosted checkout session from trusted server-owned configuration.
 *
 * The request URL/Host header is intentionally not an authority input. Redirect
 * URLs always derive from the canonical operator-configured public origin. The
 * successful mock exists only in explicit development mode; an unconfigured
 * production capability returns HTTP 503 instead of pretending checkout worked.
 *
 * @param {object} options - Checkout inputs and optional deterministic test seams.
 * @param {string|number} options.orgId - Organization that owns the checkout.
 * @param {{mode: 'disabled'|'mock'|'live', publicOrigin: string|null}} [options.configuration]
 *   Validated billing capability; defaults to startup configuration.
 * @param {(secretKey: string) => Promise<object>} [options.stripeClientFactory]
 *   Stripe client factory; injectable for deterministic provider-contract tests.
 * @returns {Promise<{url: string, live: boolean, mock?: boolean}>} Checkout target.
 * @throws {HTTPException} HTTP 503 when production billing is not configured.
 */
export async function createCheckout({
  orgId,
  configuration = billingConfiguration,
  stripeClientFactory = defaultStripeClientFactory,
}) {
  const { mode, publicOrigin } = configuration;
  if (mode === 'disabled' || !publicOrigin) {
    throw new HTTPException(503, { res: billingUnavailableResponse() });
  }

  if (mode === 'live') {
    const stripe = await stripeClientFactory(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${publicOrigin}/?billing=success`,
      cancel_url: `${publicOrigin}/?billing=cancel`,
      client_reference_id: String(orgId),
      metadata: { orgId: String(orgId) },
    });
    return { url: session.url, live: true };
  }

  return { url: `${publicOrigin}/?billing=mock&org=${encodeURIComponent(String(orgId))}`, live: false, mock: true };
}
