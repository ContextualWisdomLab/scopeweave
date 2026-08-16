const STRIPE_SUBSCRIPTION_ENDPOINT = 'https://api.stripe.com/v1/subscriptions/';
const STRIPE_REQUEST_TIMEOUT_MS = 15_000;
const STRIPE_RESPONSE_MAX_BYTES = 256 * 1024;
const MAX_PROVIDER_ID_LENGTH = 255;
const MAX_SECRET_KEY_LENGTH = 1024;
const MAX_SUBSCRIPTION_ITEMS = 100;
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/u;
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

/**
 * Stable, sanitized error raised when authoritative Stripe subscription reads fail.
 *
 * The error intentionally exposes only a bounded application code. Provider
 * response bodies, network diagnostics, secret keys, and tenant identifiers are
 * never copied into its message so HTTP/operator adapters can map failures without
 * turning provider diagnostics into an information-disclosure channel.
 */
export class StripeSubscriptionProviderError extends Error {
  /** @param {string} code - Stable ScopeWeave billing-provider error code. */
  constructor(code) {
    super(code);
    this.name = 'StripeSubscriptionProviderError';
    this.code = code;
  }
}

function providerError(code) {
  return new StripeSubscriptionProviderError(code);
}

function invalidProviderResponse() {
  return providerError('billing_subscription_provider_invalid_response');
}

function providerUnavailable() {
  return providerError('billing_subscription_provider_unavailable');
}

function providerNotFound() {
  return providerError('billing_subscription_provider_not_found');
}

function tenantMismatch() {
  return providerError('billing_subscription_tenant_mismatch');
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function requiredString(value, name, maximumLength) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new TypeError(`${name} must be a non-empty string no longer than ${maximumLength} characters`);
  }
  return normalized;
}

function providerIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROVIDER_ID_LENGTH) {
    throw invalidProviderResponse();
  }
  return value;
}

function nullableProviderIdentifier(value) {
  if (value === null) return null;
  return providerIdentifier(value);
}

function nonNegativeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidProviderResponse();
  return value;
}

function nullableTimestamp(value) {
  if (value === null) return null;
  return nonNegativeTimestamp(value);
}

async function cancelProviderBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort cleanup only. The sanitized causal error below
    // remains authoritative and must not be replaced by stream implementation detail.
  }
}

async function readBoundedProviderJson(response) {
  const declaredLengthHeader = response.headers.get('content-length');
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (!Number.isSafeInteger(declaredLength)
      || declaredLength < 0
      || declaredLength > STRIPE_RESPONSE_MAX_BYTES) {
      await cancelProviderBody(response);
      throw invalidProviderResponse();
    }
  }

  if (!response.body) throw invalidProviderResponse();

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    let result;
    try {
      result = await reader.read();
    } catch {
      throw invalidProviderResponse();
    }
    if (result.done) break;

    totalBytes += result.value.byteLength;
    if (totalBytes > STRIPE_RESPONSE_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the bounded invalid-response classification even if the stream
        // implementation also rejects cancellation.
      }
      throw invalidProviderResponse();
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalidProviderResponse();
  }
}

function normalizeAuthoritativeSubscription(payload, requestedSubscriptionId, organizationId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalidProviderResponse();
  }
  if (payload.id !== requestedSubscriptionId || payload.object !== 'subscription') {
    throw invalidProviderResponse();
  }

  const customerId = providerIdentifier(payload.customer);
  if (!STRIPE_SUBSCRIPTION_STATUSES.has(payload.status)) throw invalidProviderResponse();
  if (typeof payload.cancel_at_period_end !== 'boolean') throw invalidProviderResponse();

  const metadata = payload.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw tenantMismatch();
  }
  if (Object.hasOwn(metadata, 'orgId') && typeof metadata.orgId !== 'string') {
    throw invalidProviderResponse();
  }
  if (metadata.orgId !== String(organizationId)) throw tenantMismatch();

  const currentPeriodStartSec = nonNegativeTimestamp(payload.current_period_start);
  const currentPeriodEndSec = nonNegativeTimestamp(payload.current_period_end);
  if (currentPeriodEndSec < currentPeriodStartSec) throw invalidProviderResponse();

  if (!payload.items || typeof payload.items !== 'object' || Array.isArray(payload.items)
    || !Array.isArray(payload.items.data)
    || payload.items.data.length === 0
    || payload.items.data.length > MAX_SUBSCRIPTION_ITEMS) {
    throw invalidProviderResponse();
  }
  const priceIds = payload.items.data.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !item.price || typeof item.price !== 'object' || Array.isArray(item.price)) {
      throw invalidProviderResponse();
    }
    return providerIdentifier(item.price.id);
  });

  const snapshot = {
    subscriptionId: requestedSubscriptionId,
    customerId,
    organizationId,
    status: payload.status,
    cancelAtPeriodEnd: payload.cancel_at_period_end,
    currentPeriodStartSec,
    currentPeriodEndSec,
    canceledAtSec: nullableTimestamp(payload.canceled_at),
    endedAtSec: nullableTimestamp(payload.ended_at),
    trialEndSec: nullableTimestamp(payload.trial_end),
    latestInvoiceId: nullableProviderIdentifier(payload.latest_invoice),
    priceIds: Object.freeze(priceIds),
  };
  return Object.freeze(snapshot);
}

/**
 * Fetch and normalize the latest authoritative Stripe Subscription for one tenant.
 *
 * Stripe webhook deliveries are authenticated evidence and reconciliation triggers,
 * not an ordering guarantee. This boundary therefore performs one direct bounded
 * provider GET, validates the returned subscription identity, and requires the
 * underlying Subscription's `metadata.orgId` to match the ScopeWeave organization
 * exactly before returning lifecycle data. It makes no entitlement decision and
 * performs no local persistence mutation.
 *
 * @param {object} input - Provider authority and deterministic dependency seams.
 * @param {string|number} input.organizationId - Positive ScopeWeave organization ID.
 * @param {string} input.subscriptionId - Stripe `sub_...` identifier to retrieve.
 * @param {string} [input.secretKey=process.env.STRIPE_SECRET_KEY] - Server-owned Stripe secret.
 * @param {typeof fetch} [input.fetchImpl=globalThis.fetch] - HTTPS transport seam.
 * @param {() => AbortSignal} [input.timeoutSignalFactory] - Bounded request signal factory.
 * @returns {Promise<Readonly<{
 *   subscriptionId: string,
 *   customerId: string,
 *   organizationId: number,
 *   status: string,
 *   cancelAtPeriodEnd: boolean,
 *   currentPeriodStartSec: number,
 *   currentPeriodEndSec: number,
 *   canceledAtSec: number|null,
 *   endedAtSec: number|null,
 *   trialEndSec: number|null,
 *   latestInvoiceId: string|null,
 *   priceIds: readonly string[]
 * }>>} Frozen provider snapshot suitable for a separate reconciliation policy layer.
 * @throws {TypeError} For malformed local authority/dependency inputs.
 * @throws {StripeSubscriptionProviderError} For sanitized provider, tenant, or response failures.
 */
export async function fetchStripeSubscriptionAuthoritative({
  organizationId,
  subscriptionId,
  secretKey = process.env.STRIPE_SECRET_KEY,
  fetchImpl = globalThis.fetch,
  timeoutSignalFactory = () => AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
}) {
  const organization = positiveInteger(organizationId, 'organizationId');
  const subscription = requiredString(subscriptionId, 'subscriptionId', MAX_PROVIDER_ID_LENGTH);
  if (!SUBSCRIPTION_ID_PATTERN.test(subscription)) {
    throw new TypeError('subscriptionId must be a Stripe subscription identifier');
  }
  const key = requiredString(secretKey, 'secretKey', MAX_SECRET_KEY_LENGTH);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof timeoutSignalFactory !== 'function') {
    throw new TypeError('timeoutSignalFactory must be a function');
  }

  let signal;
  try {
    signal = timeoutSignalFactory();
  } catch {
    throw providerUnavailable();
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('timeoutSignalFactory must return an AbortSignal');
  }

  let response;
  try {
    response = await fetchImpl(`${STRIPE_SUBSCRIPTION_ENDPOINT}${encodeURIComponent(subscription)}`, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
      },
    });
  } catch {
    throw providerUnavailable();
  }

  if (!response || typeof response.ok !== 'boolean' || !response.headers) {
    throw invalidProviderResponse();
  }
  if (!response.ok) {
    await cancelProviderBody(response);
    if (response.status === 404) throw providerNotFound();
    throw providerUnavailable();
  }

  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    await cancelProviderBody(response);
    throw invalidProviderResponse();
  }

  const payload = await readBoundedProviderJson(response);
  return normalizeAuthoritativeSubscription(payload, subscription, organization);
}
