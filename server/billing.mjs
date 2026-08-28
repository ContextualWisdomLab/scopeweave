// Billing / plan configuration + checkout. Stripe is optional at install time,
// but production never substitutes a missing provider with a successful mock.
// Plan changes only ever happen server-side.
import { HTTPException } from 'hono/http-exception';
import { validateBillingStartupConfiguration } from './billing_configuration.mjs';

const billingConfiguration = validateBillingStartupConfiguration();
const STRIPE_CHECKOUT_ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';
const STRIPE_REQUEST_TIMEOUT_MS = 15_000;

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

function billingProviderUnavailableResponse() {
  return new Response(JSON.stringify({
    error: 'billing_provider_unavailable',
    action: 'Checkout could not be started. Retry later; if the problem persists, contact your ScopeWeave operator.',
  }), {
    status: 502,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=UTF-8',
    },
  });
}

function billingProviderUnavailable() {
  return new HTTPException(502, { res: billingProviderUnavailableResponse() });
}

function stripeCheckoutForm(payload) {
  return new URLSearchParams([
    ['mode', payload.mode],
    ['line_items[0][price]', payload.line_items[0].price],
    ['line_items[0][quantity]', String(payload.line_items[0].quantity)],
    ['success_url', payload.success_url],
    ['cancel_url', payload.cancel_url],
    ['client_reference_id', payload.client_reference_id],
    ['metadata[orgId]', payload.metadata.orgId],
  ]);
}

function validateCheckoutSessionUrl(session) {
  if (!session || typeof session.url !== 'string' || !session.url.trim()) {
    throw billingProviderUnavailable();
  }

  let checkoutUrl;
  try {
    checkoutUrl = new URL(session.url);
  } catch {
    throw billingProviderUnavailable();
  }

  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.username || checkoutUrl.password) {
    throw billingProviderUnavailable();
  }

  return session.url;
}

async function defaultStripeClientFactory(secretKey) {
  return {
    checkout: {
      sessions: {
        async create(payload) {
          let response;
          try {
            response = await fetch(STRIPE_CHECKOUT_ENDPOINT, {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
              headers: {
                authorization: `Bearer ${secretKey}`,
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: stripeCheckoutForm(payload).toString(),
            });
          } catch {
            throw billingProviderUnavailable();
          }

          if (!response.ok) throw billingProviderUnavailable();

          try {
            return await response.json();
          } catch {
            throw billingProviderUnavailable();
          }
        },
      },
    },
  };
}

/**
 * Create one hosted checkout session from trusted server-owned configuration.
 *
 * The request URL/Host header is intentionally not an authority input. Redirect
 * URLs always derive from the canonical operator-configured public origin. The
 * successful mock exists only in explicit development mode; an unconfigured
 * production capability returns HTTP 503 instead of pretending checkout worked.
 * Provider transport/status/payload failures return a stable HTTP 502 without
 * leaking Stripe response details to the caller.
 *
 * @param {object} options - Checkout inputs and optional deterministic test seams.
 * @param {string|number} options.orgId - Organization that owns the checkout.
 * @param {{mode: 'disabled'|'mock'|'live', publicOrigin: string|null}} [options.configuration]
 *   Validated billing capability; defaults to startup configuration.
 * @param {(secretKey: string) => Promise<object>} [options.stripeClientFactory]
 *   Stripe-compatible provider factory; injectable for deterministic contract tests.
 * @returns {Promise<{url: string, live: boolean, mock?: boolean}>} Checkout target.
 * @throws {HTTPException} HTTP 503 when billing is unconfigured or HTTP 502 when
 *   the live provider cannot produce a valid hosted Checkout Session URL.
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
    const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
    const priceId = String(process.env.STRIPE_PRICE_ID || '').trim();
    let session;
    try {
      const stripe = await stripeClientFactory(secretKey);
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${publicOrigin}/?billing=success`,
        cancel_url: `${publicOrigin}/?billing=cancel`,
        client_reference_id: String(orgId),
        metadata: { orgId: String(orgId) },
      });
    } catch {
      throw billingProviderUnavailable();
    }
    return { url: validateCheckoutSessionUrl(session), live: true };
  }

  return { url: `${publicOrigin}/?billing=mock&org=${encodeURIComponent(String(orgId))}`, live: false, mock: true };
}
