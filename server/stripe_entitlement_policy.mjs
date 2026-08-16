const SUBSCRIPTION_STATUSES = new Set([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);
const INVOICE_STATUSES = new Set(['draft', 'open', 'paid', 'uncollectible', 'void']);
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const MAX_PROVIDER_ID_LENGTH = 255;

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function providerId(value, name) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || !PROVIDER_ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a bounded provider identifier`);
  }
  return value;
}

function optionalProviderId(value, name) {
  return value == null ? null : providerId(value, name);
}

function normalizeSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('subscription must be an authoritative projection object');
  }
  const status = value.status;
  if (typeof status !== 'string' || !SUBSCRIPTION_STATUSES.has(status)) {
    throw new TypeError('subscription.status must be a supported Stripe status');
  }
  if (typeof value.cancelAtPeriodEnd !== 'boolean') {
    throw new TypeError('subscription.cancelAtPeriodEnd must be boolean');
  }
  return Object.freeze({
    observationId: positiveSafeInteger(value.observationId, 'subscription.observationId'),
    organizationId: positiveSafeInteger(value.organizationId, 'subscription.organizationId'),
    subscriptionId: providerId(value.subscriptionId, 'subscription.subscriptionId'),
    status,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd,
    currentPeriodEndSec: nonNegativeSafeInteger(value.currentPeriodEndSec, 'subscription.currentPeriodEndSec'),
    trialEndSec: value.trialEndSec == null
      ? null
      : nonNegativeSafeInteger(value.trialEndSec, 'subscription.trialEndSec'),
    latestInvoiceId: optionalProviderId(value.latestInvoiceId, 'subscription.latestInvoiceId'),
  });
}

function normalizeInvoice(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invoice must be authoritative invoice evidence');
  }
  if (typeof value.status !== 'string' || !INVOICE_STATUSES.has(value.status)) {
    throw new TypeError('invoice.status must be a supported Stripe invoice status');
  }
  return Object.freeze({
    invoiceId: providerId(value.invoiceId, 'invoice.invoiceId'),
    subscriptionId: providerId(value.subscriptionId, 'invoice.subscriptionId'),
    status: value.status,
  });
}

function freezeClaim({ organizationId, subscriptionId, entitled, validUntilSec, sourceObservationId, sourceInvoiceId }) {
  return Object.freeze({
    organizationId,
    subscriptionId,
    entitled,
    validUntilSec,
    sourceObservationId,
    sourceInvoiceId,
  });
}

function normalizePreviousClaim(value, subscription) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('previousClaim must be a subscription entitlement claim');
  }
  const organizationId = positiveSafeInteger(value.organizationId, 'previousClaim.organizationId');
  const subscriptionId = providerId(value.subscriptionId, 'previousClaim.subscriptionId');
  if (organizationId !== subscription.organizationId || subscriptionId !== subscription.subscriptionId) {
    throw new TypeError('previousClaim must match the authoritative subscription identity');
  }
  if (typeof value.entitled !== 'boolean') {
    throw new TypeError('previousClaim.entitled must be boolean');
  }
  const validUntilSec = value.validUntilSec == null
    ? null
    : nonNegativeSafeInteger(value.validUntilSec, 'previousClaim.validUntilSec');
  if (value.entitled && validUntilSec == null) {
    throw new TypeError('an entitled previousClaim requires validUntilSec');
  }
  return freezeClaim({
    organizationId,
    subscriptionId,
    entitled: value.entitled,
    validUntilSec,
    sourceObservationId: positiveSafeInteger(value.sourceObservationId, 'previousClaim.sourceObservationId'),
    sourceInvoiceId: optionalProviderId(value.sourceInvoiceId, 'previousClaim.sourceInvoiceId'),
  });
}

function inactiveClaim(subscription) {
  return freezeClaim({
    organizationId: subscription.organizationId,
    subscriptionId: subscription.subscriptionId,
    entitled: false,
    validUntilSec: null,
    sourceObservationId: subscription.observationId,
    sourceInvoiceId: null,
  });
}

function activeClaim(subscription, validUntilSec, sourceInvoiceId) {
  return freezeClaim({
    organizationId: subscription.organizationId,
    subscriptionId: subscription.subscriptionId,
    entitled: true,
    validUntilSec,
    sourceObservationId: subscription.observationId,
    sourceInvoiceId,
  });
}

function transition(action, reason, claim) {
  return Object.freeze({ action, reason, claim });
}

function isUsablePrevious(previousClaim, nowSec) {
  return Boolean(previousClaim?.entitled && previousClaim.validUntilSec > nowSec);
}

/**
 * Derive one monotonic Stripe-subscription entitlement transition from already
 * authoritative subscription and invoice facts.
 *
 * Provider status is deliberately not treated as local authorization by itself.
 * `active` requires a matching authoritative paid-invoice fact before it can
 * grant or extend access. `past_due` can only retain an already paid, unexpired
 * claim; it never creates or extends access. Terminal or non-provisioning
 * statuses fail closed. An older observation can never roll back a claim based
 * on newer accepted evidence.
 *
 * @param {{subscription: object, invoice?: object|null, previousClaim?: object|null, nowSec: number}} input policy input
 * @returns {{action: string, reason: string, claim: Readonly<object>}} immutable transition candidate
 */
export function deriveStripeSubscriptionEntitlement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input must be an entitlement policy object');
  }
  const subscription = normalizeSubscription(input.subscription);
  const invoice = normalizeInvoice(input.invoice ?? null);
  const nowSec = nonNegativeSafeInteger(input.nowSec, 'nowSec');
  const previousClaim = normalizePreviousClaim(input.previousClaim ?? null, subscription);

  if (previousClaim && subscription.observationId < previousClaim.sourceObservationId) {
    return transition('ignore', 'stale_observation', previousClaim);
  }

  if (subscription.status === 'trialing') {
    if (subscription.trialEndSec != null && subscription.trialEndSec > nowSec) {
      const claim = activeClaim(subscription, subscription.trialEndSec, null);
      return transition(isUsablePrevious(previousClaim, nowSec) ? 'retain' : 'grant', 'trialing', claim);
    }
    return transition(isUsablePrevious(previousClaim, nowSec) ? 'revoke' : 'deny', 'trial_not_usable', inactiveClaim(subscription));
  }

  if (subscription.status === 'active') {
    const paidInvoiceMatches = subscription.latestInvoiceId != null
      && invoice != null
      && invoice.status === 'paid'
      && invoice.invoiceId === subscription.latestInvoiceId
      && invoice.subscriptionId === subscription.subscriptionId;

    if (paidInvoiceMatches && subscription.currentPeriodEndSec > nowSec) {
      const claim = activeClaim(subscription, subscription.currentPeriodEndSec, invoice.invoiceId);
      if (!isUsablePrevious(previousClaim, nowSec)) {
        return transition('grant', 'paid_active_subscription', claim);
      }
      const action = claim.validUntilSec > previousClaim.validUntilSec ? 'extend' : 'retain';
      return transition(action, 'paid_active_subscription', claim);
    }

    if (isUsablePrevious(previousClaim, nowSec)) {
      return transition('retain', 'paid_invoice_evidence_required', previousClaim);
    }
    const reason = subscription.currentPeriodEndSec <= nowSec
      ? 'current_period_expired'
      : 'paid_invoice_evidence_required';
    return transition('deny', reason, inactiveClaim(subscription));
  }

  if (subscription.status === 'past_due') {
    if (isUsablePrevious(previousClaim, nowSec)) {
      return transition('retain', 'past_due_no_extension', previousClaim);
    }
    return transition(previousClaim?.entitled ? 'revoke' : 'deny', 'past_due_no_active_claim', inactiveClaim(subscription));
  }

  return transition(
    isUsablePrevious(previousClaim, nowSec) ? 'revoke' : 'deny',
    `subscription_${subscription.status}`,
    inactiveClaim(subscription),
  );
}

/**
 * Aggregate current per-subscription claims into one organization entitlement.
 * A revoked or canceled subscription cannot erase another independent paid or
 * trial claim for the same organization. Duplicate subscription identities are
 * invalid because aggregation requires exactly one current claim per Subscription.
 *
 * @param {{organizationId: number, claims: object[], nowSec: number}} input aggregation input
 * @returns {Readonly<{organizationId: number, entitled: boolean, validUntilSec: number|null, subscriptionIds: readonly string[]}>} organization entitlement view
 */
export function deriveOrganizationStripeEntitlement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('input must be an organization entitlement object');
  }
  const organizationId = positiveSafeInteger(input.organizationId, 'organizationId');
  const nowSec = nonNegativeSafeInteger(input.nowSec, 'nowSec');
  if (!Array.isArray(input.claims)) {
    throw new TypeError('claims must be an array');
  }

  const activeClaims = [];
  const seenSubscriptionIds = new Set();
  for (const value of input.claims) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('each claim must be an entitlement claim object');
    }
    if (positiveSafeInteger(value.organizationId, 'claim.organizationId') !== organizationId) {
      throw new TypeError('claim organization must match aggregation authority');
    }
    const subscriptionId = providerId(value.subscriptionId, 'claim.subscriptionId');
    if (seenSubscriptionIds.has(subscriptionId)) {
      throw new TypeError('duplicate subscription claim identity');
    }
    seenSubscriptionIds.add(subscriptionId);
    if (typeof value.entitled !== 'boolean') {
      throw new TypeError('claim.entitled must be boolean');
    }
    const validUntilSec = value.validUntilSec == null
      ? null
      : nonNegativeSafeInteger(value.validUntilSec, 'claim.validUntilSec');
    if (value.entitled && validUntilSec == null) {
      throw new TypeError('an entitled claim requires validUntilSec');
    }
    if (value.entitled && validUntilSec > nowSec) {
      activeClaims.push({ subscriptionId, validUntilSec });
    }
  }

  activeClaims.sort((left, right) => left.subscriptionId.localeCompare(right.subscriptionId));
  const subscriptionIds = Object.freeze(activeClaims.map(({ subscriptionId }) => subscriptionId));
  const validUntilSec = activeClaims.length === 0
    ? null
    : Math.max(...activeClaims.map((claim) => claim.validUntilSec));
  return Object.freeze({
    organizationId,
    entitled: activeClaims.length > 0,
    validUntilSec,
    subscriptionIds,
  });
}
