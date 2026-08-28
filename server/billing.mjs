// Billing / plan configuration + checkout. Stripe is optional at install time,
// but production never substitutes a missing provider with a successful mock.
// Plan changes only ever happen server-side.
import { HTTPException } from 'hono/http-exception';
import { validateBillingStartupConfiguration } from './billing_configuration.mjs';

const billingConfiguration = validateBillingStartupConfiguration();
const STRIPE_CHECKOUT_ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';
const STRIPE_REQUEST_TIMEOUT_MS = 15_000;
const STRIPE_RESPONSE_MAX_BYTES = 1024 * 1024;

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

function jsonErrorResponse(status, error, action) {
  return new Response(JSON.stringify({ error, action }), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=UTF-8',
    },
  });
}

function billingUnavailableResponse() {
  return jsonErrorResponse(
    503,
    'billing_not_configured',
    'Configure the complete Stripe billing settings and SCOPEWEAVE_PUBLIC_ORIGIN, then restart ScopeWeave.',
  );
}

function providerFailure(code, action) {
  return new HTTPException(502, {
    res: jsonErrorResponse(502, code, action),
  });
}

function providerUnavailableFailure() {
  return providerFailure(
    'billing_provider_unavailable',
    'Retry checkout. If the problem persists, verify Stripe connectivity and service health before retrying.',
  );
}

function providerInvalidResponseFailure() {
  return providerFailure(
    'billing_provider_invalid_response',
    'Retry checkout. If the problem persists, verify the Stripe Checkout provider configuration and service health.',
  );
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

async function readBoundedProviderJson(response) {
  const declaredLengthHeader = response.headers.get('content-length');
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (!Number.isSafeInteger(declaredLength)
      || declaredLength < 0
      || declaredLength > STRIPE_RESPONSE_MAX_BYTES) {
      try {
        await response.body?.cancel();
      } finally {
        throw providerInvalidResponseFailure();
      }
    }
  }

  if (!response.body) {
    throw providerInvalidResponseFailure();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    let readResult;
    try {
      readResult = await reader.read();
    } catch {
      throw providerInvalidResponseFailure();
    }
    if (readResult.done) break;

    totalBytes += readResult.value.byteLength;
    if (totalBytes > STRIPE_RESPONSE_MAX_BYTES) {
      try {
        await reader.cancel();
      } finally {
        throw providerInvalidResponseFailure();
      }
    }
    chunks.push(readResult.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw providerInvalidResponseFailure();
  }
}

async function cancelUnreadProviderBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup failure must never replace the stable provider failure returned below.
  }
}

async function createStripeSessionWithFetch(secretKey, payload) {
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
    throw providerUnavailableFailure();
  }

  if (!response.ok) {
    await cancelUnreadProviderBody(response);
    throw providerUnavailableFailure();
  }

  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    await cancelUnreadProviderBody(response);
    throw providerInvalidResponseFailure();
  }

  return readBoundedProviderJson(response);
}

function validateHostedCheckoutUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw providerInvalidResponseFailure();
  }

  let checkoutUrl;
  try {
    checkoutUrl = new URL(rawUrl);
  } catch {
    throw providerInvalidResponseFailure();
  }

  const untrustedDestination = checkoutUrl.protocol !== 'https:'
    || checkoutUrl.hostname !== 'checkout.stripe.com'
    || checkoutUrl.port !== ''
    || checkoutUrl.username !== ''
    || checkoutUrl.password !== '';
  if (untrustedDestination) {
    throw providerInvalidResponseFailure();
  }

  // Stripe's documented hosted Checkout URLs can include an opaque client-side
  // fragment. It does not participate in HTTPS authority selection and must be
  // preserved verbatim so the browser receives the provider-issued URL intact.
  return rawUrl;
}

/**
 * Create one hosted checkout session from trusted server-owned configuration.
 *
 * The request URL/Host header is intentionally not an authority input. Redirect
 * URLs always derive from the canonical operator-configured public origin. The
 * successful mock exists only in explicit development mode; an unconfigured
 * production capability returns HTTP 503 instead of pretending checkout worked.
 * Live provider calls use one direct HTTPS attempt with a 15-second total budget
 * and a 1 MiB response-body ceiling until durable checkout-attempt idempotency
 * state exists. The hosted destination must use Stripe's standard HTTPS authority;
 * provider-issued client fragments are preserved verbatim.
 *
 * @param {object} options - Checkout inputs and optional deterministic test seams.
 * @param {string|number} options.orgId - Organization that owns the checkout.
 * @param {{mode: 'disabled'|'mock'|'live', publicOrigin: string|null}} [options.configuration]
 *   Validated billing capability; defaults to startup configuration.
 * @param {(secretKey: string) => Promise<object>} [options.stripeClientFactory]
 *   Optional Stripe-compatible test seam. Production uses the direct HTTPS transport.
 * @returns {Promise<{url: string, live: boolean, mock?: boolean}>} Checkout target.
 * @throws {HTTPException} HTTP 503 when production billing is not configured;
 *   HTTP 502 when the provider call fails or returns an untrusted destination.
 */
export async function createCheckout({
  orgId,
  configuration = billingConfiguration,
  stripeClientFactory,
}) {
  const { mode, publicOrigin } = configuration;
  if (mode === 'disabled' || !publicOrigin) {
    throw new HTTPException(503, { res: billingUnavailableResponse() });
  }

  if (mode === 'live') {
    const payload = {
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${publicOrigin}/?billing=success`,
      cancel_url: `${publicOrigin}/?billing=cancel`,
      client_reference_id: String(orgId),
      metadata: { orgId: String(orgId) },
    };

    let session;
    if (stripeClientFactory) {
      try {
        const stripe = await stripeClientFactory(process.env.STRIPE_SECRET_KEY);
        session = await stripe.checkout.sessions.create(payload);
      } catch {
        throw providerUnavailableFailure();
      }
    } else {
      session = await createStripeSessionWithFetch(process.env.STRIPE_SECRET_KEY, payload);
    }

    return {
      url: validateHostedCheckoutUrl(session?.url),
      live: true,
    };
  }

  return { url: `${publicOrigin}/?billing=mock&org=${encodeURIComponent(String(orgId))}`, live: false, mock: true };
}
