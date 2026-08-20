const MAX_PROVIDER_ID_LENGTH = 255;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/u;
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/u;
const CANONICAL_ORG_ID_PATTERN = /^[1-9]\d*$/u;

/**
 * Stable fail-closed signal for a verified event that cannot yet be reconciled safely.
 *
 * A 503 is intentional: the webhook event has already passed signature verification
 * and durable event recording, but ScopeWeave has no durable authority to apply the
 * event as a reconciliation trigger yet. Returning a retryable status preserves
 * eventual convergence without letting event metadata become tenant authority.
 */
export class StripeWebhookReconciliationTriggerError extends Error {
  /**
   * Create a stable retryable trigger failure.
   * @param {string} code machine-readable failure code
   * @param {number} status retryable HTTP status for the webhook adapter
   */
  constructor(code = 'stripe_webhook_reconciliation_deferred', status = 503) {
    super(code);
    this.name = 'StripeWebhookReconciliationTriggerError';
    this.code = code;
    this.status = status;
  }
}

function deferred() {
  return new StripeWebhookReconciliationTriggerError();
}

function boundedIdentifier(value, pattern) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PROVIDER_ID_LENGTH
    && pattern.test(value)
    ? value
    : null;
}

function positiveOrganizationId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function metadataOrganizationHint(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { present: false, organizationId: null };
  }
  if (!Object.hasOwn(metadata, 'orgId')) return { present: false, organizationId: null };
  const raw = metadata.orgId;
  if (typeof raw !== 'string' || !CANONICAL_ORG_ID_PATTERN.test(raw)) {
    return { present: true, organizationId: null };
  }
  const organizationId = positiveOrganizationId(raw);
  return { present: true, organizationId };
}

function requireEventEnvelope(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw deferred();
  const eventId = boundedIdentifier(event.id, EVENT_ID_PATTERN);
  if (!eventId
    || typeof event.type !== 'string'
    || event.type.length === 0
    || event.type.length > MAX_PROVIDER_ID_LENGTH) {
    throw deferred();
  }
  return { eventId, eventType: event.type, object: event.data?.object };
}

function requirePort(port, name) {
  if (typeof port !== 'function') throw new TypeError(`${name} must be a function`);
}

function normalizedAuthority(authority, expectedSubscriptionId) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) throw deferred();
  const organizationId = positiveOrganizationId(authority.organizationId);
  const subscriptionId = boundedIdentifier(authority.subscriptionId, SUBSCRIPTION_ID_PATTERN);
  if (!organizationId || !subscriptionId || subscriptionId !== expectedSubscriptionId) throw deferred();
  return { organizationId, subscriptionId };
}

function normalizedCheckoutAuthority(authority, expectedSessionId) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) throw deferred();
  const organizationId = positiveOrganizationId(authority.organizationId);
  const providerSessionId = boundedIdentifier(authority.providerSessionId, CHECKOUT_SESSION_ID_PATTERN);
  if (!organizationId || providerSessionId !== expectedSessionId) throw deferred();
  return { organizationId };
}

function invoiceSubscriptionEvidence(invoice) {
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
    return {
      subscriptionId: null,
      ownershipHint: { present: false, organizationId: null },
      malformed: true,
    };
  }

  const legacy = invoice.subscription == null
    ? null
    : boundedIdentifier(invoice.subscription, SUBSCRIPTION_ID_PATTERN);

  let current = null;
  let ownershipHint = { present: false, organizationId: null };
  if (invoice.parent?.type === 'subscription_details') {
    const details = invoice.parent.subscription_details;
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      return { subscriptionId: null, ownershipHint, malformed: true };
    }
    current = details.subscription == null
      ? null
      : boundedIdentifier(details.subscription, SUBSCRIPTION_ID_PATTERN);
    ownershipHint = metadataOrganizationHint(details.metadata);
  }

  if (invoice.subscription != null && !legacy) {
    return { subscriptionId: null, ownershipHint, malformed: true };
  }
  if (invoice.parent?.type === 'subscription_details'
    && invoice.parent.subscription_details?.subscription != null
    && !current) {
    return { subscriptionId: null, ownershipHint, malformed: true };
  }
  if (legacy && current && legacy !== current) {
    return { subscriptionId: null, ownershipHint, malformed: true };
  }

  return { subscriptionId: current || legacy, ownershipHint, malformed: false };
}

async function reconcile(reconcileBilling, authority, eventId) {
  await reconcileBilling({
    organizationId: authority.organizationId,
    subscriptionId: authority.subscriptionId,
    sourceEventId: eventId,
  });
  return Object.freeze({ outcome: 'reconciled' });
}

/**
 * Convert one already-verified Stripe Event into a bounded current-state reconciliation trigger.
 *
 * Tenant authority never comes from webhook metadata. A completed Checkout Session can bootstrap
 * the first durable Subscription binding only when its signed Session ID already matches a local
 * successful Checkout attempt; metadata is then only a contradiction/ownership hint. Later
 * Subscription and Invoice events resolve organization authority through the normalized local
 * Subscription binding. If a ScopeWeave-marked event arrives before that durable authority exists,
 * the function fails retryably so out-of-order delivery can converge after the Checkout event.
 *
 * Invoice provenance supports both Stripe's current Basil `parent.subscription_details` shape and
 * the pre-Basil top-level `subscription` field, while failing closed if both are present and differ.
 * Irrelevant or clearly non-ScopeWeave events are acknowledged as ignored and never reach provider
 * reconciliation.
 *
 * @param {object} input trigger input and authority ports
 * @param {Record<string, unknown>} input.event already signature-verified Stripe Event
 * @param {(sessionId:string) => object|null} input.resolveCheckoutSessionAuthority local Checkout-attempt lookup
 * @param {(subscriptionId:string) => object|null} input.resolveSubscriptionAuthority durable Subscription lookup
 * @param {(input:{organizationId:number, subscriptionId:string, sourceEventId:string}) => Promise<unknown>} input.reconcileBilling current-provider reconciliation service
 * @returns {Promise<Readonly<{outcome:'ignored'|'reconciled'}>>} bounded trigger outcome
 */
export async function triggerStripeBillingReconciliationFromVerifiedEvent({
  event,
  resolveCheckoutSessionAuthority,
  resolveSubscriptionAuthority,
  reconcileBilling,
}) {
  requirePort(resolveCheckoutSessionAuthority, 'resolveCheckoutSessionAuthority');
  requirePort(resolveSubscriptionAuthority, 'resolveSubscriptionAuthority');
  requirePort(reconcileBilling, 'reconcileBilling');

  const { eventId, eventType, object } = requireEventEnvelope(event);

  if (eventType === 'checkout.session.completed') {
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw deferred();
    if (object.mode != null && object.mode !== 'subscription') {
      return Object.freeze({ outcome: 'ignored' });
    }
    const sessionId = boundedIdentifier(object.id, CHECKOUT_SESSION_ID_PATTERN);
    const subscriptionId = boundedIdentifier(object.subscription, SUBSCRIPTION_ID_PATTERN);
    const ownershipHint = metadataOrganizationHint(object.metadata);
    if (!sessionId || !subscriptionId) {
      if (ownershipHint.present) throw deferred();
      return Object.freeze({ outcome: 'ignored' });
    }

    const rawAuthority = resolveCheckoutSessionAuthority(sessionId);
    if (rawAuthority == null) {
      if (ownershipHint.present) throw deferred();
      return Object.freeze({ outcome: 'ignored' });
    }
    const checkoutAuthority = normalizedCheckoutAuthority(rawAuthority, sessionId);
    if (ownershipHint.present
      && (!ownershipHint.organizationId || ownershipHint.organizationId !== checkoutAuthority.organizationId)) {
      throw deferred();
    }
    return reconcile(reconcileBilling, {
      organizationId: checkoutAuthority.organizationId,
      subscriptionId,
    }, eventId);
  }

  if (eventType.startsWith('customer.subscription.')) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw deferred();
    const subscriptionId = boundedIdentifier(object.id, SUBSCRIPTION_ID_PATTERN);
    const ownershipHint = metadataOrganizationHint(object.metadata);
    if (!subscriptionId) throw deferred();
    const rawAuthority = resolveSubscriptionAuthority(subscriptionId);
    if (rawAuthority == null) {
      if (ownershipHint.present) throw deferred();
      return Object.freeze({ outcome: 'ignored' });
    }
    return reconcile(reconcileBilling, normalizedAuthority(rawAuthority, subscriptionId), eventId);
  }

  if (eventType.startsWith('invoice.')) {
    const evidence = invoiceSubscriptionEvidence(object);
    if (evidence.malformed) throw deferred();
    if (!evidence.subscriptionId) {
      if (evidence.ownershipHint.present) throw deferred();
      return Object.freeze({ outcome: 'ignored' });
    }
    const rawAuthority = resolveSubscriptionAuthority(evidence.subscriptionId);
    if (rawAuthority == null) {
      if (evidence.ownershipHint.present) throw deferred();
      return Object.freeze({ outcome: 'ignored' });
    }
    return reconcile(
      reconcileBilling,
      normalizedAuthority(rawAuthority, evidence.subscriptionId),
      eventId,
    );
  }

  return Object.freeze({ outcome: 'ignored' });
}
