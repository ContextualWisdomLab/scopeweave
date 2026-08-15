// Billing / plan configuration + checkout. Stripe is optional at install time,
// but production never substitutes a missing provider with a successful mock.
// Plan changes only ever happen server-side.
import { HTTPException } from 'hono/http-exception';
import { validateBillingStartupConfiguration } from './billing_configuration.mjs';

const billingConfiguration = validateBillingStartupConfiguration();
const STRIPE_CHECKOUT_ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';
const STRIPE_REQUEST_TIMEOUT_MS = 15_000;
const STRIPE_RESPONSE_MAX_BYTES = 1024 * 1024;
const STRIPE_PROVIDER_ID_MAX_LENGTH = 255;

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

function checkoutStateFailure() {
  return new HTTPException(503, {
    res: jsonErrorResponse(
      503,
      'billing_checkout_state_unavailable',
      'Retry checkout after durable billing state is healthy; do not bypass the checkout-attempt ledger.',
    ),
  });
}

function providerFailure(code, action, { outcomeKnown = false } = {}) {
  const error = new HTTPException(502, {
    res: jsonErrorResponse(502, code, action),
  });
  Object.defineProperty(error, 'providerOutcomeKnown', {
    value: outcomeKnown,
    enumerable: false,
  });
  return error;
}

function providerUnavailableFailure(outcomeKnown = false) {
  return providerFailure(
    'billing_provider_unavailable',
    'Retry checkout. If the problem persists, verify Stripe connectivity and service health before retrying.',
    { outcomeKnown },
  );
}

function providerInvalidResponseFailure() {
  return providerFailure(
    'billing_provider_invalid_response',
    'Retry checkout. If the problem persists, verify the Stripe Checkout provider configuration and service health.',
    { outcomeKnown: true },
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

async function createStripeSessionWithFetch(secretKey, payload, idempotencyKey) {
  let response;
  try {
    response = await fetch(STRIPE_CHECKOUT_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': idempotencyKey,
      },
      body: stripeCheckoutForm(payload).toString(),
    });
  } catch {
    // No HTTP response means the provider outcome is uncertain. Keep the durable
    // pending attempt so the next caller reuses this exact idempotency key.
    throw providerUnavailableFailure(false);
  }

  if (!response.ok) {
    // A received provider response is a known outcome for this attempt. The
    // caller can close this retry identity before surfacing the stable error.
    throw providerUnavailableFailure(true);
  }

  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
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

function validateProviderSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > STRIPE_PROVIDER_ID_MAX_LENGTH) {
    throw providerInvalidResponseFailure();
  }
  return value;
}

function requireAttemptRepository(repository) {
  if (!repository
    || typeof repository.startAttempt !== 'function'
    || typeof repository.markProviderSucceeded !== 'function'
    || typeof repository.markProviderFailed !== 'function') {
    throw checkoutStateFailure();
  }
  return repository;
}

async function resolveAttemptRepository(repository) {
  if (repository !== undefined) return requireAttemptRepository(repository);
  try {
    // The app already owns the database singleton. Dynamic resolution keeps the
    // billing domain directly testable without opening a database at import time,
    // while the real live route still uses the bootstrap-installed durable port.
    const { billingCheckoutAttempts } = await import('./db.mjs');
    return requireAttemptRepository(billingCheckoutAttempts);
  } catch {
    throw checkoutStateFailure();
  }
}

function markKnownProviderFailure(repository, attemptId, error) {
  if (error?.providerOutcomeKnown !== true) return;
  try {
    repository.markProviderFailed({ attemptId });
  } catch {
    throw checkoutStateFailure();
  }
}

/**
 * Create one hosted checkout session from trusted server-owned configuration.
 *
 * The request URL/Host header is intentionally not an authority input. Redirect
 * URLs always derive from the canonical operator-configured public origin. The
 * successful mock exists only in explicit development mode; an unconfigured
 * production capability returns HTTP 503 instead of pretending checkout worked.
 * Live provider calls use one direct HTTPS attempt with a 15-second total budget,
 * a 1 MiB response-body ceiling, and a durable per-attempt idempotency key. A
 * network/abort failure keeps that attempt pending so a later call safely reuses
 * the same key; a received provider failure closes it so a deliberate later
 * checkout gets fresh provider authority. The hosted destination must use
 * Stripe's standard HTTPS authority; provider-issued client fragments are
 * preserved verbatim.
 *
 * @param {object} options - Checkout inputs and optional deterministic test seams.
 * @param {string|number} options.orgId - Organization that owns the checkout.
 * @param {{mode: 'disabled'|'mock'|'live', publicOrigin: string|null}} [options.configuration]
 *   Validated billing capability; defaults to startup configuration.
 * @param {{startAttempt: Function, markProviderSucceeded: Function, markProviderFailed: Function}} [options.attemptRepository]
 *   Durable live-mode Checkout-attempt persistence port. Production resolves the
 *   bootstrap-installed database port when omitted; tests should inject a seam.
 * @param {(secretKey: string) => Promise<object>} [options.stripeClientFactory]
 *   Optional Stripe-compatible test seam. Production uses the direct HTTPS transport.
 * @returns {Promise<{url: string, live: boolean, mock?: boolean, checkoutAttemptId?: string}>} Checkout target.
 * @throws {HTTPException} HTTP 503 when production billing/state is unavailable;
 *   HTTP 502 when the provider call fails or returns an untrusted destination.
 */
export async function createCheckout({
  orgId,
  configuration = billingConfiguration,
  attemptRepository,
  stripeClientFactory,
}) {
  const { mode, publicOrigin } = configuration;
  if (mode === 'disabled' || !publicOrigin) {
    throw new HTTPException(503, { res: billingUnavailableResponse() });
  }

  if (mode === 'live') {
    const repository = await resolveAttemptRepository(attemptRepository);
    const priceId = process.env.STRIPE_PRICE_ID;
    let attempt;
    try {
      attempt = repository.startAttempt({ organizationId: orgId, priceId });
    } catch {
      throw checkoutStateFailure();
    }

    const payload = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${publicOrigin}/?billing=success`,
      cancel_url: `${publicOrigin}/?billing=cancel`,
      client_reference_id: String(orgId),
      metadata: { orgId: String(orgId) },
    };

    let session;
    try {
      if (stripeClientFactory) {
        try {
          const stripe = await stripeClientFactory(process.env.STRIPE_SECRET_KEY);
          session = await stripe.checkout.sessions.create(payload, {
            idempotencyKey: attempt.idempotencyKey,
          });
        } catch {
          // The injected seam models an SDK/network boundary. Without a concrete
          // provider response, its outcome is uncertain and must remain retryable.
          throw providerUnavailableFailure(false);
        }
      } else {
        session = await createStripeSessionWithFetch(
          process.env.STRIPE_SECRET_KEY,
          payload,
          attempt.idempotencyKey,
        );
      }

      const providerSessionId = validateProviderSessionId(session?.id);
      const hostedUrl = validateHostedCheckoutUrl(session?.url);
      try {
        repository.markProviderSucceeded({
          attemptId: attempt.attemptId,
          providerSessionId,
        });
      } catch {
        throw checkoutStateFailure();
      }

      return {
        url: hostedUrl,
        live: true,
        checkoutAttemptId: attempt.attemptId,
      };
    } catch (error) {
      markKnownProviderFailure(repository, attempt.attemptId, error);
      throw error;
    }
  }

  return { url: `${publicOrigin}/?billing=mock&org=${encodeURIComponent(String(orgId))}`, live: false, mock: true };
}