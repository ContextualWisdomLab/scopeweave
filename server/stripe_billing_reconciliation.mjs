import { fetchStripeInvoiceAuthoritative } from './stripe_invoice_provider.mjs';
import { fetchStripeSubscriptionAuthoritative } from './stripe_subscription_provider.mjs';

const MAX_PROVIDER_ID_LENGTH = 255;
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/u;
const INVOICE_ID_PATTERN = /^in_[A-Za-z0-9_]+$/u;
const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/u;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const CLAIM_CONFLICT_CODE = 'stripe_entitlement_claim_conflict';

function positiveOrganizationId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('organizationId must be a positive safe integer');
  }
  return value;
}

function boundedIdentifier(value, name, pattern) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || !pattern.test(value)) {
    throw new TypeError(`${name} must be a bounded provider identifier`);
  }
  return value;
}

function optionalEventId(value) {
  if (value == null) return null;
  return boundedIdentifier(value, 'sourceEventId', EVENT_ID_PATTERN);
}

function requiredMethod(owner, methodName, ownerName) {
  if (!owner || typeof owner !== 'object' || typeof owner[methodName] !== 'function') {
    throw new TypeError(`${ownerName} must provide ${methodName}()`);
  }
}

function positiveResultId(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertSubscriptionSnapshot(snapshot, authority) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('fetchSubscription must return a subscription snapshot');
  }
  if (snapshot.organizationId !== authority.organizationId
    || snapshot.subscriptionId !== authority.subscriptionId) {
    throw new TypeError('subscription snapshot does not match local authority');
  }
  boundedIdentifier(snapshot.customerId, 'snapshot.customerId', CUSTOMER_ID_PATTERN);
  if (snapshot.latestInvoiceId != null) {
    boundedIdentifier(snapshot.latestInvoiceId, 'snapshot.latestInvoiceId', INVOICE_ID_PATTERN);
  }
}

function assertInvoiceSnapshot(snapshot, authority) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('fetchInvoice must return an invoice snapshot');
  }
  if (snapshot.organizationId !== authority.organizationId
    || snapshot.subscriptionId !== authority.subscriptionId
    || snapshot.customerId !== authority.customerId
    || snapshot.invoiceId !== authority.invoiceId) {
    throw new TypeError('invoice snapshot does not match accepted subscription authority');
  }
}

function providerDependencies({ secretKey, fetchImpl, timeoutSignalFactory }) {
  const dependencies = {};
  if (secretKey !== undefined) dependencies.secretKey = secretKey;
  if (fetchImpl !== undefined) dependencies.fetchImpl = fetchImpl;
  if (timeoutSignalFactory !== undefined) dependencies.timeoutSignalFactory = timeoutSignalFactory;
  return dependencies;
}

function currentDecisionId(claim) {
  if (claim == null) return null;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new TypeError('claimRepository.getCurrentClaim() returned an invalid claim');
  }
  return positiveResultId(claim.decisionId, 'claim.decisionId');
}

function isClaimConflict(error) {
  return error != null && typeof error === 'object' && error.code === CLAIM_CONFLICT_CODE;
}

function applyClaimWithOneConflictRetry(claimRepository, authority) {
  const initialClaim = claimRepository.getCurrentClaim(authority);
  const initialDecisionId = currentDecisionId(initialClaim);

  try {
    return claimRepository.applyCurrentDecision({
      ...authority,
      expectedPreviousDecisionId: initialDecisionId,
    });
  } catch (error) {
    if (!isClaimConflict(error)) throw error;
  }

  const refreshedClaim = claimRepository.getCurrentClaim(authority);
  const refreshedDecisionId = currentDecisionId(refreshedClaim);
  return claimRepository.applyCurrentDecision({
    ...authority,
    expectedPreviousDecisionId: refreshedDecisionId,
  });
}

/**
 * Reconcile one tenant-owned Stripe Subscription from current provider authority.
 *
 * Webhook delivery order is deliberately not an ordering signal. Every invocation
 * retrieves the current Subscription directly from Stripe, appends that accepted
 * provider observation, optionally retrieves and appends the Subscription's current
 * Invoice, and only then asks the durable claim repository to evaluate the latest
 * accepted evidence. A webhook event identifier may be retained as provenance, but
 * it never selects provider state or entitlement authority.
 *
 * One optimistic claim-head conflict is expected under concurrent reconciliation.
 * In that case only claim application is retried after refreshing the current durable
 * decision; provider reads and accepted observations are not repeated. A second
 * conflict, provider failure, persistence failure, or policy failure remains causal
 * and propagates to the caller for bounded operator/job retry.
 *
 * The returned value contains evidence and decision identifiers only. Provider
 * payloads, secrets, retry authority, `orgs.plan`, sessions, and RBAC state never
 * cross this boundary.
 *
 * @param {object} input reconciliation authority and dependency ports
 * @param {number} input.organizationId positive ScopeWeave organization ID
 * @param {string} input.subscriptionId exact tenant-owned Stripe Subscription ID
 * @param {string|null} [input.sourceEventId=null] optional verified event provenance
 * @param {Function} [input.fetchSubscription] authoritative Subscription read port
 * @param {Function} [input.fetchInvoice] authoritative Invoice read port
 * @param {object} input.subscriptionRepository append-only Subscription evidence port
 * @param {object} input.invoiceRepository append-only Invoice evidence port
 * @param {object} input.claimRepository durable entitlement claim decision port
 * @param {string} [input.secretKey] server-owned Stripe secret forwarded to provider ports
 * @param {typeof fetch} [input.fetchImpl] provider transport seam
 * @param {() => AbortSignal} [input.timeoutSignalFactory] provider timeout seam
 * @returns {Promise<Readonly<{organizationId:number, subscriptionId:string, subscriptionObservationId:number, invoiceObservationId:number|null, claimDecisionId:number}>>}
 * bounded reconciliation receipt
 */
export async function reconcileStripeBillingAuthoritatively({
  organizationId,
  subscriptionId,
  sourceEventId = null,
  fetchSubscription = fetchStripeSubscriptionAuthoritative,
  fetchInvoice = fetchStripeInvoiceAuthoritative,
  subscriptionRepository,
  invoiceRepository,
  claimRepository,
  secretKey = process.env.STRIPE_SECRET_KEY,
  fetchImpl = globalThis.fetch,
  timeoutSignalFactory,
}) {
  const authority = Object.freeze({
    organizationId: positiveOrganizationId(organizationId),
    subscriptionId: boundedIdentifier(subscriptionId, 'subscriptionId', SUBSCRIPTION_ID_PATTERN),
  });
  const eventId = optionalEventId(sourceEventId);

  if (typeof fetchSubscription !== 'function') throw new TypeError('fetchSubscription must be a function');
  if (typeof fetchInvoice !== 'function') throw new TypeError('fetchInvoice must be a function');
  requiredMethod(subscriptionRepository, 'recordAuthoritativeObservation', 'subscriptionRepository');
  requiredMethod(invoiceRepository, 'recordAuthoritativeObservation', 'invoiceRepository');
  requiredMethod(claimRepository, 'getCurrentClaim', 'claimRepository');
  requiredMethod(claimRepository, 'applyCurrentDecision', 'claimRepository');

  const providerOptions = providerDependencies({ secretKey, fetchImpl, timeoutSignalFactory });
  const subscriptionSnapshot = await fetchSubscription({
    ...authority,
    ...providerOptions,
  });
  assertSubscriptionSnapshot(subscriptionSnapshot, authority);

  const subscriptionEvidence = subscriptionRepository.recordAuthoritativeObservation({
    snapshot: subscriptionSnapshot,
    sourceEventId: eventId,
  });
  const subscriptionObservationId = positiveResultId(
    subscriptionEvidence?.observationId,
    'subscriptionEvidence.observationId',
  );

  let invoiceObservationId = null;
  if (subscriptionSnapshot.latestInvoiceId != null) {
    const invoiceAuthority = Object.freeze({
      organizationId: authority.organizationId,
      invoiceId: boundedIdentifier(subscriptionSnapshot.latestInvoiceId, 'latestInvoiceId', INVOICE_ID_PATTERN),
      subscriptionId: authority.subscriptionId,
      customerId: boundedIdentifier(subscriptionSnapshot.customerId, 'customerId', CUSTOMER_ID_PATTERN),
    });
    const invoiceSnapshot = await fetchInvoice({
      ...invoiceAuthority,
      ...providerOptions,
    });
    assertInvoiceSnapshot(invoiceSnapshot, invoiceAuthority);

    const invoiceEvidence = invoiceRepository.recordAuthoritativeObservation({
      snapshot: invoiceSnapshot,
      sourceSubscriptionObservationId: subscriptionObservationId,
      sourceEventId: eventId,
    });
    invoiceObservationId = positiveResultId(
      invoiceEvidence?.observationId,
      'invoiceEvidence.observationId',
    );
  }

  const claim = applyClaimWithOneConflictRetry(claimRepository, authority);
  const claimDecisionId = positiveResultId(claim?.decisionId, 'claim.decisionId');

  return Object.freeze({
    organizationId: authority.organizationId,
    subscriptionId: authority.subscriptionId,
    subscriptionObservationId,
    invoiceObservationId,
    claimDecisionId,
  });
}
