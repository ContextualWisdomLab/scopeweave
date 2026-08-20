const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:-]+$/u;
const MAX_PROVIDER_ID_LENGTH = 255;
const MAX_REASON_LENGTH = 120;
const SAVEPOINT_NAME = 'billing_stripe_entitlement_claim_write';
const DECISION_ACTIONS = new Set(['ignore', 'grant', 'retain', 'extend', 'revoke', 'deny']);

/** Stable persistence/concurrency error for Stripe entitlement claim decisions. */
export class StripeEntitlementClaimError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'StripeEntitlementClaimError';
    this.code = code;
    this.status = status;
  }
}

function claimError(code = 'stripe_entitlement_claim_invalid', status = 400) {
  return new StripeEntitlementClaimError(code, status);
}

function positiveSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw claimError();
  return value;
}

function nonNegativeSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw claimError();
  return value;
}

function providerId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROVIDER_ID_LENGTH || !PROVIDER_IDENTIFIER_PATTERN.test(value)) {
    throw claimError();
  }
  return value;
}

function optionalDecisionId(value) {
  return value == null ? null : positiveSafeInteger(value);
}

function nowValue(clock) {
  return nonNegativeSafeInteger(Number(clock()));
}

function freezeClaim(row) {
  if (!row) return null;
  return Object.freeze({
    decisionId: Number(row.decision_id),
    organizationId: Number(row.organization_id),
    subscriptionId: row.subscription_id,
    entitled: Number(row.entitled) === 1,
    validUntilSec: row.valid_until_sec == null ? null : Number(row.valid_until_sec),
    sourceObservationId: Number(row.claim_subscription_observation_id),
    sourceInvoiceId: row.claim_invoice_id ?? null,
    sourceInvoiceObservationId: row.claim_invoice_observation_id == null ? null : Number(row.claim_invoice_observation_id),
    action: row.decision_action,
    reason: row.decision_reason,
    evaluatedSubscriptionObservationId: Number(row.evaluated_subscription_observation_id),
    evaluatedInvoiceObservationId: row.evaluated_invoice_observation_id == null ? null : Number(row.evaluated_invoice_observation_id),
    evaluatedAtSec: Number(row.evaluated_at_sec),
  });
}

function withSavepoint(database, operation) {
  database.exec(`SAVEPOINT ${SAVEPOINT_NAME}`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    return result;
  } catch (error) {
    let rolledBack = false;
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
      rolledBack = true;
    } catch {
      // Do not release unconfirmed state: outermost RELEASE could commit it.
    }
    if (rolledBack) {
      try { database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`); } catch { /* causal error wins */ }
    }
    throw error;
  }
}

function policyTransition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw claimError('stripe_entitlement_policy_invalid', 500);
  if (!DECISION_ACTIONS.has(value.action)) throw claimError('stripe_entitlement_policy_invalid', 500);
  if (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > MAX_REASON_LENGTH) {
    throw claimError('stripe_entitlement_policy_invalid', 500);
  }
  const claim = value.claim;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw claimError('stripe_entitlement_policy_invalid', 500);
  if (typeof claim.entitled !== 'boolean') throw claimError('stripe_entitlement_policy_invalid', 500);
  const validUntilSec = claim.validUntilSec == null ? null : nonNegativeSafeInteger(claim.validUntilSec);
  if (claim.entitled && validUntilSec == null) throw claimError('stripe_entitlement_policy_invalid', 500);
  return {
    action: value.action,
    reason: value.reason,
    claim: {
      organizationId: positiveSafeInteger(claim.organizationId),
      subscriptionId: providerId(claim.subscriptionId),
      entitled: claim.entitled,
      validUntilSec,
      sourceObservationId: positiveSafeInteger(claim.sourceObservationId),
      sourceInvoiceId: claim.sourceInvoiceId == null ? null : providerId(claim.sourceInvoiceId),
    },
  };
}

/** Install append-only Stripe entitlement decisions and the per-Subscription current head. */
export function installStripeEntitlementClaimSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS billing_stripe_entitlement_decisions (
      decision_id INTEGER PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES billing_stripe_subscriptions(subscription_id) ON DELETE CASCADE,
      evaluated_subscription_observation_id INTEGER NOT NULL REFERENCES billing_stripe_subscription_observations(observation_id) ON DELETE RESTRICT,
      evaluated_invoice_observation_id INTEGER REFERENCES billing_stripe_invoice_observations(observation_id) ON DELETE RESTRICT,
      previous_decision_id INTEGER REFERENCES billing_stripe_entitlement_decisions(decision_id) ON DELETE RESTRICT,
      decision_action TEXT NOT NULL CHECK(decision_action IN ('ignore','grant','retain','extend','revoke','deny')),
      decision_reason TEXT NOT NULL CHECK(length(decision_reason) BETWEEN 1 AND ${MAX_REASON_LENGTH}),
      entitled INTEGER NOT NULL CHECK(entitled IN (0,1)),
      valid_until_sec INTEGER CHECK(valid_until_sec IS NULL OR valid_until_sec >= 0),
      claim_subscription_observation_id INTEGER NOT NULL REFERENCES billing_stripe_subscription_observations(observation_id) ON DELETE RESTRICT,
      claim_invoice_observation_id INTEGER REFERENCES billing_stripe_invoice_observations(observation_id) ON DELETE RESTRICT,
      evaluated_at_sec INTEGER NOT NULL CHECK(evaluated_at_sec >= 0),
      recorded_at_ms INTEGER NOT NULL CHECK(recorded_at_ms >= 0),
      CHECK((entitled = 1 AND valid_until_sec IS NOT NULL) OR entitled = 0),
      UNIQUE(subscription_id, decision_id)
    );
    CREATE INDEX IF NOT EXISTS billing_stripe_entitlement_decision_history
      ON billing_stripe_entitlement_decisions(subscription_id, decision_id);
    CREATE INDEX IF NOT EXISTS billing_stripe_entitlement_subscription_sources
      ON billing_stripe_entitlement_decisions(evaluated_subscription_observation_id, decision_id);
    CREATE INDEX IF NOT EXISTS billing_stripe_entitlement_invoice_sources
      ON billing_stripe_entitlement_decisions(evaluated_invoice_observation_id, decision_id);

    CREATE TABLE IF NOT EXISTS billing_stripe_entitlement_claim_heads (
      subscription_id TEXT PRIMARY KEY REFERENCES billing_stripe_subscriptions(subscription_id) ON DELETE CASCADE,
      decision_id INTEGER NOT NULL UNIQUE,
      FOREIGN KEY(subscription_id, decision_id)
        REFERENCES billing_stripe_entitlement_decisions(subscription_id, decision_id) ON DELETE RESTRICT
    );
  `);
}

/**
 * Create the transactional claim-decision repository.
 *
 * The repository chooses the latest accepted Subscription observation and the
 * latest accepted Invoice observation for its `latest_invoice_id` itself, then
 * passes those persisted facts plus the current durable claim to the deterministic
 * entitlement policy. Callers cannot choose stale provider evidence. The expected
 * previous decision ID is an optimistic concurrency token; every successful
 * evaluation appends an audit decision and atomically advances the current head.
 *
 * This layer persists claim decisions only. It never writes `orgs.plan`, session
 * capabilities, or any external authorization state.
 */
export function createSqliteStripeEntitlementClaimRepository(database, {
  deriveEntitlement,
  nowSec = () => Math.floor(Date.now() / 1000),
  nowMs = Date.now,
} = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite prepare/exec operations');
  }
  if (typeof deriveEntitlement !== 'function') throw new TypeError('deriveEntitlement must be a function');
  if (typeof nowSec !== 'function' || typeof nowMs !== 'function') throw new TypeError('clock dependencies must be functions');

  const selectCurrentSubscription = database.prepare(`
    SELECT o.observation_id, c.organization_id, s.customer_id, o.subscription_id,
           o.subscription_status, o.cancel_at_period_end, o.current_period_end_sec,
           o.trial_end_sec, o.latest_invoice_id
    FROM billing_stripe_subscription_observations o
    JOIN billing_stripe_subscriptions s ON s.subscription_id = o.subscription_id
    JOIN billing_stripe_customers c ON c.customer_id = s.customer_id
    WHERE c.organization_id = ? AND o.subscription_id = ?
    ORDER BY o.observation_id DESC LIMIT 1
  `);
  const selectCurrentInvoice = database.prepare(`
    SELECT o.observation_id, i.subscription_id, o.invoice_id, o.invoice_status
    FROM billing_stripe_invoice_observations o
    JOIN billing_stripe_invoices i ON i.invoice_id = o.invoice_id
    WHERE i.subscription_id = ? AND o.invoice_id = ?
    ORDER BY o.observation_id DESC LIMIT 1
  `);
  const selectHead = database.prepare(`
    SELECT h.decision_id, c.organization_id, d.subscription_id, d.entitled,
           d.valid_until_sec, d.claim_subscription_observation_id,
           ci.invoice_id AS claim_invoice_id, d.claim_invoice_observation_id,
           d.decision_action, d.decision_reason,
           d.evaluated_subscription_observation_id,
           d.evaluated_invoice_observation_id, d.evaluated_at_sec
    FROM billing_stripe_entitlement_claim_heads h
    JOIN billing_stripe_entitlement_decisions d ON d.decision_id = h.decision_id
    JOIN billing_stripe_subscriptions s ON s.subscription_id = d.subscription_id
    JOIN billing_stripe_customers c ON c.customer_id = s.customer_id
    LEFT JOIN billing_stripe_invoice_observations cio ON cio.observation_id = d.claim_invoice_observation_id
    LEFT JOIN billing_stripe_invoices ci ON ci.invoice_id = cio.invoice_id
    WHERE h.subscription_id = ?
  `);
  const selectClaimSubscription = database.prepare(`
    SELECT o.observation_id, c.organization_id, o.subscription_id
    FROM billing_stripe_subscription_observations o
    JOIN billing_stripe_subscriptions s ON s.subscription_id = o.subscription_id
    JOIN billing_stripe_customers c ON c.customer_id = s.customer_id
    WHERE o.observation_id = ?
  `);
  const selectClaimInvoice = database.prepare(`
    SELECT o.observation_id, i.invoice_id, i.subscription_id
    FROM billing_stripe_invoice_observations o
    JOIN billing_stripe_invoices i ON i.invoice_id = o.invoice_id
    WHERE o.observation_id = ?
  `);
  const insertDecision = database.prepare(`
    INSERT INTO billing_stripe_entitlement_decisions(
      subscription_id, evaluated_subscription_observation_id, evaluated_invoice_observation_id,
      previous_decision_id, decision_action, decision_reason, entitled, valid_until_sec,
      claim_subscription_observation_id, claim_invoice_observation_id,
      evaluated_at_sec, recorded_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const upsertHead = database.prepare(`
    INSERT INTO billing_stripe_entitlement_claim_heads(subscription_id, decision_id)
    VALUES(?,?)
    ON CONFLICT(subscription_id) DO UPDATE SET decision_id = excluded.decision_id
  `);

  function getCurrentClaimById(subscriptionId) {
    return freezeClaim(selectHead.get(subscriptionId));
  }

  return Object.freeze({
    /** Return the durable current claim for one exact tenant-owned Subscription. */
    getCurrentClaim({ organizationId, subscriptionId }) {
      const orgId = positiveSafeInteger(organizationId);
      const subId = providerId(subscriptionId);
      const currentSubscription = selectCurrentSubscription.get(orgId, subId);
      if (!currentSubscription) return null;
      return getCurrentClaimById(subId);
    },

    /** Re-evaluate current persisted evidence and atomically append/advance one claim decision. */
    applyCurrentDecision({ organizationId, subscriptionId, expectedPreviousDecisionId = null }) {
      const orgId = positiveSafeInteger(organizationId);
      const subId = providerId(subscriptionId);
      const expected = optionalDecisionId(expectedPreviousDecisionId);
      const evaluatedAtSec = nowValue(nowSec);
      const recordedAtMs = nowValue(nowMs);

      return withSavepoint(database, () => {
        const subscriptionRow = selectCurrentSubscription.get(orgId, subId);
        if (!subscriptionRow) throw claimError('stripe_entitlement_subscription_unknown', 404);
        const previous = getCurrentClaimById(subId);
        const currentDecisionId = previous?.decisionId ?? null;
        if (currentDecisionId !== expected) throw claimError('stripe_entitlement_claim_conflict', 409);

        const invoiceRow = subscriptionRow.latest_invoice_id == null
          ? null
          : selectCurrentInvoice.get(subId, subscriptionRow.latest_invoice_id) ?? null;
        const subscription = {
          observationId: Number(subscriptionRow.observation_id),
          organizationId: Number(subscriptionRow.organization_id),
          subscriptionId: subscriptionRow.subscription_id,
          status: subscriptionRow.subscription_status,
          cancelAtPeriodEnd: Number(subscriptionRow.cancel_at_period_end) === 1,
          currentPeriodEndSec: Number(subscriptionRow.current_period_end_sec),
          trialEndSec: subscriptionRow.trial_end_sec == null ? null : Number(subscriptionRow.trial_end_sec),
          latestInvoiceId: subscriptionRow.latest_invoice_id ?? null,
        };
        const invoice = invoiceRow == null ? null : {
          invoiceId: invoiceRow.invoice_id,
          subscriptionId: invoiceRow.subscription_id,
          status: invoiceRow.invoice_status,
        };
        const previousClaim = previous == null ? null : {
          organizationId: previous.organizationId,
          subscriptionId: previous.subscriptionId,
          entitled: previous.entitled,
          validUntilSec: previous.validUntilSec,
          sourceObservationId: previous.sourceObservationId,
          sourceInvoiceId: previous.sourceInvoiceId,
        };

        const transition = policyTransition(deriveEntitlement({ subscription, invoice, previousClaim, nowSec: evaluatedAtSec }));
        if (transition.claim.organizationId !== orgId || transition.claim.subscriptionId !== subId) {
          throw claimError('stripe_entitlement_policy_invalid', 500);
        }
        const claimSubscription = selectClaimSubscription.get(transition.claim.sourceObservationId);
        if (!claimSubscription
          || Number(claimSubscription.organization_id) !== orgId
          || claimSubscription.subscription_id !== subId) {
          throw claimError('stripe_entitlement_policy_invalid', 500);
        }

        let claimInvoiceObservationId = null;
        if (transition.claim.sourceInvoiceId != null) {
          if (invoiceRow && invoiceRow.invoice_id === transition.claim.sourceInvoiceId) {
            claimInvoiceObservationId = Number(invoiceRow.observation_id);
          } else if (previous?.sourceInvoiceId === transition.claim.sourceInvoiceId) {
            claimInvoiceObservationId = previous.sourceInvoiceObservationId;
          }
          const claimInvoice = claimInvoiceObservationId == null ? null : selectClaimInvoice.get(claimInvoiceObservationId);
          if (!claimInvoice
            || claimInvoice.invoice_id !== transition.claim.sourceInvoiceId
            || claimInvoice.subscription_id !== subId) {
            throw claimError('stripe_entitlement_policy_invalid', 500);
          }
        }

        const result = insertDecision.run(
          subId,
          Number(subscriptionRow.observation_id),
          invoiceRow == null ? null : Number(invoiceRow.observation_id),
          currentDecisionId,
          transition.action,
          transition.reason,
          transition.claim.entitled ? 1 : 0,
          transition.claim.validUntilSec,
          transition.claim.sourceObservationId,
          claimInvoiceObservationId,
          evaluatedAtSec,
          recordedAtMs,
        );
        const decisionId = Number(result.lastInsertRowid);
        upsertHead.run(subId, decisionId);
        return getCurrentClaimById(subId);
      });
    },
  });
}
