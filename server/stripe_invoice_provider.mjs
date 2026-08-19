const STRIPE_INVOICE_ENDPOINT = 'https://api.stripe.com/v1/invoices/';
const STRIPE_REQUEST_TIMEOUT_MS = 15_000;
const STRIPE_RESPONSE_MAX_BYTES = 256 * 1024;
const MAX_PROVIDER_ID_LENGTH = 255;
const MAX_SECRET_KEY_LENGTH = 1024;
const INVOICE_ID_PATTERN = /^in_[A-Za-z0-9_]+$/u;
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/u;
const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/u;
const CURRENCY_PATTERN = /^[a-z]{3}$/u;
const STRIPE_INVOICE_STATUSES = new Set(['draft', 'open', 'paid', 'uncollectible', 'void']);

/**
 * Stable sanitized failure from the authoritative Stripe Invoice read boundary.
 * Provider response bodies, network diagnostics, credentials, and tenant details
 * are deliberately excluded from the public message.
 */
export class StripeInvoiceProviderError extends Error {
  /** @param {string} code - Stable ScopeWeave invoice-provider error code. */
  constructor(code) {
    super(code);
    this.name = 'StripeInvoiceProviderError';
    this.code = code;
  }
}

function providerError(code) { return new StripeInvoiceProviderError(code); }
function invalidProviderResponse() { return providerError('billing_invoice_provider_invalid_response'); }
function providerUnavailable() { return providerError('billing_invoice_provider_unavailable'); }
function providerNotFound() { return providerError('billing_invoice_provider_not_found'); }
function tenantMismatch() { return providerError('billing_invoice_tenant_mismatch'); }

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function localIdentifier(value, name, pattern) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROVIDER_ID_LENGTH || !pattern.test(value)) {
    throw new TypeError(`${name} must be a bounded Stripe identifier`);
  }
  return value;
}

function secretKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_KEY_LENGTH) {
    throw new TypeError(`secretKey must be a non-empty string no longer than ${MAX_SECRET_KEY_LENGTH} characters`);
  }
  return value;
}

function providerIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROVIDER_ID_LENGTH) throw invalidProviderResponse();
  return value;
}

function nonNegativeSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidProviderResponse();
  return value;
}

function nullableTimestamp(value) {
  if (value === null) return null;
  return nonNegativeSafeInteger(value);
}

async function cancelProviderBody(response) {
  try { await response.body?.cancel(); } catch { /* best-effort cleanup */ }
}

async function readBoundedProviderJson(response) {
  const declaredLengthHeader = response.headers.get('content-length');
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > STRIPE_RESPONSE_MAX_BYTES) {
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
    try { result = await reader.read(); } catch { throw invalidProviderResponse(); }
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > STRIPE_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
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

function metadataOrganization(metadata, organizationId) {
  if (metadata == null) return;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw invalidProviderResponse();
  if (!Object.hasOwn(metadata, 'orgId')) return;
  if (typeof metadata.orgId !== 'string') throw invalidProviderResponse();
  if (metadata.orgId !== String(organizationId)) throw tenantMismatch();
}

function subscriptionIdentity(payload, organizationId) {
  let currentId = null;
  if (payload.parent != null) {
    if (typeof payload.parent !== 'object' || Array.isArray(payload.parent) || payload.parent.type !== 'subscription_details') {
      throw invalidProviderResponse();
    }
    const details = payload.parent.subscription_details;
    if (!details || typeof details !== 'object' || Array.isArray(details)) throw invalidProviderResponse();
    currentId = providerIdentifier(details.subscription);
    metadataOrganization(details.metadata, organizationId);
  }

  let legacyId = null;
  if (payload.subscription != null) legacyId = providerIdentifier(payload.subscription);
  if (payload.subscription_details != null) {
    if (typeof payload.subscription_details !== 'object' || Array.isArray(payload.subscription_details)) throw invalidProviderResponse();
    metadataOrganization(payload.subscription_details.metadata, organizationId);
  }
  if (currentId && legacyId && currentId !== legacyId) throw invalidProviderResponse();
  const resolved = currentId ?? legacyId;
  if (!resolved) throw invalidProviderResponse();
  return resolved;
}

function normalizeAuthoritativeInvoice(payload, authority) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidProviderResponse();
  if (payload.id !== authority.invoiceId || payload.object !== 'invoice') throw invalidProviderResponse();
  if (providerIdentifier(payload.customer) !== authority.customerId) throw tenantMismatch();

  const subscriptionId = subscriptionIdentity(payload, authority.organizationId);
  if (subscriptionId !== authority.subscriptionId) throw tenantMismatch();
  if (typeof payload.status !== 'string' || !STRIPE_INVOICE_STATUSES.has(payload.status)) throw invalidProviderResponse();
  if (typeof payload.paid !== 'boolean' || payload.paid !== (payload.status === 'paid')) throw invalidProviderResponse();
  if (typeof payload.currency !== 'string' || !CURRENCY_PATTERN.test(payload.currency)) throw invalidProviderResponse();

  if (!payload.status_transitions || typeof payload.status_transitions !== 'object' || Array.isArray(payload.status_transitions)) {
    throw invalidProviderResponse();
  }
  const paidAtSec = nullableTimestamp(payload.status_transitions.paid_at);
  if ((payload.status === 'paid') !== (paidAtSec !== null)) throw invalidProviderResponse();

  return Object.freeze({
    invoiceId: authority.invoiceId,
    subscriptionId,
    customerId: authority.customerId,
    organizationId: authority.organizationId,
    status: payload.status,
    paid: payload.paid,
    currency: payload.currency,
    amountDue: nonNegativeSafeInteger(payload.amount_due),
    amountPaid: nonNegativeSafeInteger(payload.amount_paid),
    amountRemaining: nonNegativeSafeInteger(payload.amount_remaining),
    createdSec: nonNegativeSafeInteger(payload.created),
    paidAtSec,
  });
}

/**
 * Fetch and normalize one authoritative Stripe Invoice for a known tenant-bound
 * customer and Subscription.
 *
 * The request deliberately follows the Stripe account's configured API version.
 * Current Basil invoices identify their generating Subscription under
 * `parent.subscription_details.subscription`; older accounts can still expose the
 * legacy top-level `subscription` field. Both shapes are accepted only when they
 * agree, while server-owned customer/Subscription authority remains mandatory.
 * This boundary returns payment evidence only and never grants local entitlement.
 *
 * @param {object} input - Tenant authority and deterministic transport seams.
 * @param {number} input.organizationId - Positive ScopeWeave organization ID.
 * @param {string} input.invoiceId - Exact Stripe `in_...` Invoice ID.
 * @param {string} input.subscriptionId - Exact tenant-bound Stripe `sub_...` ID.
 * @param {string} input.customerId - Exact tenant-bound Stripe `cus_...` ID.
 * @param {string} [input.secretKey=process.env.STRIPE_SECRET_KEY] - Server-owned provider secret.
 * @param {typeof fetch} [input.fetchImpl=globalThis.fetch] - HTTPS transport seam.
 * @param {() => AbortSignal} [input.timeoutSignalFactory] - Bounded request signal factory.
 * @returns {Promise<Readonly<object>>} Frozen normalized Invoice evidence for policy evaluation.
 * @throws {TypeError} For malformed local authority or dependency inputs.
 * @throws {StripeInvoiceProviderError} For sanitized provider, response, or tenant failures.
 */
export async function fetchStripeInvoiceAuthoritative({
  organizationId,
  invoiceId,
  subscriptionId,
  customerId,
  secretKey: secret = process.env.STRIPE_SECRET_KEY,
  fetchImpl = globalThis.fetch,
  timeoutSignalFactory = () => AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
}) {
  const authority = Object.freeze({
    organizationId: positiveSafeInteger(organizationId, 'organizationId'),
    invoiceId: localIdentifier(invoiceId, 'invoiceId', INVOICE_ID_PATTERN),
    subscriptionId: localIdentifier(subscriptionId, 'subscriptionId', SUBSCRIPTION_ID_PATTERN),
    customerId: localIdentifier(customerId, 'customerId', CUSTOMER_ID_PATTERN),
  });
  const key = secretKey(secret);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof timeoutSignalFactory !== 'function') throw new TypeError('timeoutSignalFactory must be a function');

  let signal;
  try { signal = timeoutSignalFactory(); } catch { throw providerUnavailable(); }
  if (!(signal instanceof AbortSignal)) throw new TypeError('timeoutSignalFactory must return an AbortSignal');

  let response;
  try {
    response = await fetchImpl(`${STRIPE_INVOICE_ENDPOINT}${encodeURIComponent(authority.invoiceId)}`, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    });
  } catch {
    throw providerUnavailable();
  }

  if (!response || typeof response.ok !== 'boolean' || !response.headers) throw invalidProviderResponse();
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

  return normalizeAuthoritativeInvoice(await readBoundedProviderJson(response), authority);
}
