const MAX_PROVIDER_ID_LENGTH = 255;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/u;
const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/u;
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/u;
const SAVEPOINT_NAME = 'billing_stripe_checkout_identity_bootstrap';

/** Stable fail-closed error for Checkout-completion identity bootstrap. */
export class StripeCheckoutIdentityBootstrapError extends Error {
  /**
   * Create one sanitized identity-bootstrap failure.
   * @param {string} code stable machine-readable failure code
   * @param {number} [status=400] HTTP-compatible adapter status
   */
  constructor(code, status = 400) {
    super(code);
    this.name = 'StripeCheckoutIdentityBootstrapError';
    this.code = code;
    this.status = status;
  }
}

function bootstrapError(code, status = 400) {
  return new StripeCheckoutIdentityBootstrapError(code, status);
}

function boundedIdentifier(value, pattern) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROVIDER_ID_LENGTH
    || !pattern.test(value)
  ) {
    throw bootstrapError('stripe_checkout_identity_invalid');
  }
  return value;
}

function normalizedCheckoutCompletion(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw bootstrapError('stripe_checkout_identity_invalid');
  }
  const eventId = boundedIdentifier(event.id, EVENT_ID_PATTERN);
  if (event.type !== 'checkout.session.completed') {
    throw bootstrapError('stripe_checkout_identity_invalid');
  }
  const session = event.data?.object;
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw bootstrapError('stripe_checkout_identity_invalid');
  }
  if (session.object !== 'checkout.session' || session.mode !== 'subscription') {
    throw bootstrapError('stripe_checkout_identity_invalid');
  }
  return Object.freeze({
    eventId,
    sessionId: boundedIdentifier(session.id, SESSION_ID_PATTERN),
    customerId: boundedIdentifier(session.customer, CUSTOMER_ID_PATTERN),
    subscriptionId: boundedIdentifier(session.subscription, SUBSCRIPTION_ID_PATTERN),
  });
}

function withSavepoint(database, operation) {
  database.exec(`SAVEPOINT ${SAVEPOINT_NAME}`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    return result;
  } catch (error) {
    let rollbackSucceeded = false;
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
      rollbackSucceeded = true;
    } catch {
      // Leave an unconfirmed failed savepoint open rather than risk partial commit.
    }
    if (rollbackSucceeded) {
      try {
        database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
      } catch {
        // Cleanup after confirmed rollback must not replace the causal failure.
      }
    }
    throw error;
  }
}

/**
 * Permanently bind verified Checkout Subscription identities to local tenant authority.
 *
 * The tenant source of truth is the already-succeeded local Checkout attempt whose
 * server-recorded Stripe Session ID exactly matches the verified
 * `checkout.session.completed` object. Signed Checkout customer/subscription fields
 * therefore cannot choose an organization by themselves. The immutable verified
 * event ledger must independently agree on event type, object type, and Session ID.
 *
 * Customer and Subscription identities are inserted into the same normalized tables
 * used by authoritative Subscription observations. Existing identical bindings are
 * idempotent; ambiguous local Session ownership or any Customer/Subscription rebind
 * attempt fails closed. Both identity writes share one SQLite savepoint and this
 * boundary never changes `orgs.plan`, entitlement claims, sessions, or RBAC.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped SQLite database
 * @param {Record<string, unknown>} event cryptographically verified Stripe event
 * @returns {Readonly<{eventId:string, organizationId:number, customerId:string, subscriptionId:string, bound:boolean}>}
 * durable tenant/provider identity receipt
 * @throws {StripeCheckoutIdentityBootstrapError} when authority is malformed, absent, ambiguous, or conflicting
 */
export function bindVerifiedStripeCheckoutSessionIdentity(database, event) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite prepare/exec operations');
  }
  const completion = normalizedCheckoutCompletion(event);

  const selectVerifiedEvent = database.prepare(`
    SELECT event_type, object_id, object_type, first_received_at_ms
      FROM billing_stripe_webhook_events
     WHERE event_id = ?
  `);
  const selectAttempts = database.prepare(`
    SELECT organization_id
      FROM billing_checkout_attempts
     WHERE provider_session_id = ?
       AND attempt_state = 'provider_succeeded'
     ORDER BY attempt_id
     LIMIT 2
  `);
  const selectCustomer = database.prepare(`
    SELECT organization_id
      FROM billing_stripe_customers
     WHERE customer_id = ?
  `);
  const selectSubscription = database.prepare(`
    SELECT customer_id
      FROM billing_stripe_subscriptions
     WHERE subscription_id = ?
  `);
  const insertCustomer = database.prepare(`
    INSERT INTO billing_stripe_customers(customer_id, organization_id, first_observed_at_ms)
    VALUES(?,?,?)
  `);
  const insertSubscription = database.prepare(`
    INSERT INTO billing_stripe_subscriptions(subscription_id, customer_id, first_observed_at_ms)
    VALUES(?,?,?)
  `);

  return withSavepoint(database, () => {
    const verified = selectVerifiedEvent.get(completion.eventId);
    if (!verified
      || verified.event_type !== 'checkout.session.completed'
      || verified.object_type !== 'checkout.session'
      || verified.object_id !== completion.sessionId
      || !Number.isSafeInteger(verified.first_received_at_ms)
      || verified.first_received_at_ms < 0) {
      throw bootstrapError('stripe_checkout_identity_unverified', 409);
    }

    const attempts = selectAttempts.all(completion.sessionId);
    if (attempts.length === 0) {
      throw bootstrapError('stripe_checkout_identity_unmatched', 409);
    }
    if (attempts.length !== 1) {
      throw bootstrapError('stripe_checkout_identity_ambiguous', 409);
    }
    const organizationId = Number(attempts[0].organization_id);
    if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
      throw bootstrapError('stripe_checkout_identity_ambiguous', 409);
    }

    const existingCustomer = selectCustomer.get(completion.customerId);
    if (existingCustomer && Number(existingCustomer.organization_id) !== organizationId) {
      throw bootstrapError('stripe_checkout_identity_conflict', 409);
    }
    const existingSubscription = selectSubscription.get(completion.subscriptionId);
    if (existingSubscription && existingSubscription.customer_id !== completion.customerId) {
      throw bootstrapError('stripe_checkout_identity_conflict', 409);
    }

    let bound = false;
    if (!existingCustomer) {
      insertCustomer.run(
        completion.customerId,
        organizationId,
        verified.first_received_at_ms,
      );
      bound = true;
    }
    if (!existingSubscription) {
      insertSubscription.run(
        completion.subscriptionId,
        completion.customerId,
        verified.first_received_at_ms,
      );
      bound = true;
    }

    return Object.freeze({
      eventId: completion.eventId,
      organizationId,
      customerId: completion.customerId,
      subscriptionId: completion.subscriptionId,
      bound,
    });
  });
}
