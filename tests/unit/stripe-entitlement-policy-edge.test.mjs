import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveOrganizationStripeEntitlement,
  deriveStripeSubscriptionEntitlement,
} from '../../server/stripe_entitlement_policy.mjs';

const NOW = 1_787_000_000;

function subscription(overrides = {}) {
  return {
    observationId: 10,
    organizationId: 42,
    subscriptionId: 'sub_scopeweave_42',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEndSec: NOW + 2_592_000,
    trialEndSec: null,
    latestInvoiceId: 'in_scopeweave_paid',
    ...overrides,
  };
}

function paidInvoice(overrides = {}) {
  return {
    invoiceId: 'in_scopeweave_paid',
    subscriptionId: 'sub_scopeweave_42',
    status: 'paid',
    ...overrides,
  };
}

function previousClaim(overrides = {}) {
  return {
    organizationId: 42,
    subscriptionId: 'sub_scopeweave_42',
    entitled: true,
    validUntilSec: NOW + 86_400,
    sourceObservationId: 9,
    sourceInvoiceId: 'in_scopeweave_previous',
    ...overrides,
  };
}

test('active status at an expired provider period fails closed even with a paid invoice', () => {
  const denied = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ currentPeriodEndSec: NOW }),
    invoice: paidInvoice(),
    nowSec: NOW,
  });
  assert.equal(denied.action, 'deny');
  assert.equal(denied.reason, 'current_period_expired');
  assert.equal(denied.claim.entitled, false);
});

test('trialing grants only to a future authoritative trial end and exact expiry denies', () => {
  const trial = deriveStripeSubscriptionEntitlement({
    subscription: subscription({
      status: 'trialing',
      trialEndSec: NOW + 3_600,
      latestInvoiceId: null,
    }),
    nowSec: NOW,
  });
  assert.equal(trial.action, 'grant');
  assert.equal(trial.reason, 'trialing');
  assert.equal(trial.claim.validUntilSec, NOW + 3_600);
  assert.equal(trial.claim.sourceInvoiceId, null);

  for (const trialEndSec of [null, NOW, NOW - 1]) {
    const denied = deriveStripeSubscriptionEntitlement({
      subscription: subscription({ status: 'trialing', trialEndSec, latestInvoiceId: null }),
      previousClaim: previousClaim(),
      nowSec: NOW,
    });
    assert.equal(denied.action, 'revoke');
    assert.equal(denied.reason, 'trial_not_usable');
  }
});

test('past_due retains a previously paid unexpired claim but never provisions or extends it', () => {
  const retained = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ status: 'past_due' }),
    invoice: paidInvoice(),
    previousClaim: previousClaim(),
    nowSec: NOW,
  });
  assert.equal(retained.action, 'retain');
  assert.equal(retained.reason, 'past_due_no_extension');
  assert.deepEqual(retained.claim, previousClaim());

  const denied = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ status: 'past_due' }),
    invoice: paidInvoice(),
    nowSec: NOW,
  });
  assert.equal(denied.action, 'deny');
  assert.equal(denied.reason, 'past_due_no_active_claim');

  const revoked = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ status: 'past_due', observationId: 11 }),
    previousClaim: previousClaim({ validUntilSec: NOW, entitled: true }),
    nowSec: NOW,
  });
  assert.equal(revoked.action, 'revoke');
  assert.equal(revoked.claim.entitled, false);
});

test('non-provisioning and terminal subscription statuses revoke an unexpired claim', () => {
  for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'paused', 'canceled']) {
    const result = deriveStripeSubscriptionEntitlement({
      subscription: subscription({ status }),
      previousClaim: previousClaim(),
      nowSec: NOW,
    });
    assert.equal(result.action, 'revoke');
    assert.equal(result.reason, `subscription_${status}`);
    assert.equal(result.claim.entitled, false);
  }
});

test('an older observation cannot roll back a newer accepted entitlement claim', () => {
  const previous = previousClaim({
    sourceObservationId: 20,
    validUntilSec: NOW + 2_592_000,
    sourceInvoiceId: 'in_newer',
  });
  const result = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ observationId: 19, status: 'canceled' }),
    previousClaim: previous,
    nowSec: NOW,
  });
  assert.equal(result.action, 'ignore');
  assert.equal(result.reason, 'stale_observation');
  assert.deepEqual(result.claim, previous);
});

test('same observation can be safely enriched later by matching paid invoice evidence', () => {
  const inconclusive = deriveStripeSubscriptionEntitlement({
    subscription: subscription(),
    nowSec: NOW,
  });
  assert.equal(inconclusive.claim.sourceObservationId, 10);
  assert.equal(inconclusive.claim.entitled, false);

  const granted = deriveStripeSubscriptionEntitlement({
    subscription: subscription(),
    invoice: paidInvoice(),
    previousClaim: inconclusive.claim,
    nowSec: NOW,
  });
  assert.equal(granted.action, 'grant');
  assert.equal(granted.claim.sourceObservationId, 10);
  assert.equal(granted.claim.entitled, true);
});

test('organization aggregation preserves access when another subscription is canceled or expired', () => {
  const result = deriveOrganizationStripeEntitlement({
    organizationId: 42,
    nowSec: NOW,
    claims: [
      { organizationId: 42, subscriptionId: 'sub_zeta', entitled: false, validUntilSec: null },
      { organizationId: 42, subscriptionId: 'sub_alpha', entitled: true, validUntilSec: NOW + 3_600 },
      { organizationId: 42, subscriptionId: 'sub_expired', entitled: true, validUntilSec: NOW },
      { organizationId: 42, subscriptionId: 'sub_beta', entitled: true, validUntilSec: NOW + 7_200 },
    ],
  });
  assert.deepEqual(result, {
    organizationId: 42,
    entitled: true,
    validUntilSec: NOW + 7_200,
    subscriptionIds: ['sub_alpha', 'sub_beta'],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.subscriptionIds), true);

  assert.deepEqual(deriveOrganizationStripeEntitlement({ organizationId: 42, nowSec: NOW, claims: [] }), {
    organizationId: 42,
    entitled: false,
    validUntilSec: null,
    subscriptionIds: [],
  });
});

test('policy rejects malformed or cross-tenant evidence before making an entitlement decision', () => {
  for (const bad of [null, [], 'x']) {
    assert.throws(() => deriveStripeSubscriptionEntitlement(bad), TypeError);
  }
  for (const status of ['unknown', '', null]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({ subscription: subscription({ status }), nowSec: NOW }), TypeError);
  }
  assert.throws(() => deriveStripeSubscriptionEntitlement({
    subscription: subscription({ cancelAtPeriodEnd: 'false' }),
    nowSec: NOW,
  }), TypeError);
  assert.throws(() => deriveStripeSubscriptionEntitlement({
    subscription: subscription(),
    invoice: paidInvoice({ status: 'unknown' }),
    nowSec: NOW,
  }), TypeError);
  assert.throws(() => deriveStripeSubscriptionEntitlement({
    subscription: subscription(),
    previousClaim: previousClaim({ organizationId: 84 }),
    nowSec: NOW,
  }), TypeError);
  assert.throws(() => deriveOrganizationStripeEntitlement({
    organizationId: 42,
    nowSec: NOW,
    claims: [{ organizationId: 84, subscriptionId: 'sub_other', entitled: false, validUntilSec: null }],
  }), TypeError);
});

test('policy edge validation covers every bounded evidence field and aggregation invariant', () => {
  const baseInput = { subscription: subscription(), nowSec: NOW };
  for (const badSubscription of [null, [], 'x']) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({ ...baseInput, subscription: badSubscription }), TypeError);
  }

  for (const observationId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({
      ...baseInput,
      subscription: subscription({ observationId }),
    }), TypeError);
  }
  for (const organizationId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({
      ...baseInput,
      subscription: subscription({ organizationId }),
    }), TypeError);
  }
  for (const subscriptionId of [null, '', ' ', 'x'.repeat(256)]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({
      ...baseInput,
      subscription: subscription({ subscriptionId }),
    }), TypeError);
  }
  for (const currentPeriodEndSec of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({
      ...baseInput,
      subscription: subscription({ currentPeriodEndSec }),
    }), TypeError);
  }
  for (const trialEndSec of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({
      ...baseInput,
      subscription: subscription({ status: 'trialing', trialEndSec, latestInvoiceId: null }),
    }), TypeError);
  }
  for (const latestInvoiceId of ['', ' ', 'x'.repeat(256)]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({
      ...baseInput,
      subscription: subscription({ latestInvoiceId }),
    }), TypeError);
  }
  for (const nowSec of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({ ...baseInput, nowSec }), TypeError);
  }

  for (const invoice of [[], 'x']) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({ ...baseInput, invoice }), TypeError);
  }
  for (const invoiceId of [null, '', ' ', 'x'.repeat(256)]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({
      ...baseInput,
      invoice: paidInvoice({ invoiceId }),
    }), TypeError);
  }
  for (const subscriptionId of [null, '', ' ', 'x'.repeat(256)]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({
      ...baseInput,
      invoice: paidInvoice({ subscriptionId }),
    }), TypeError);
  }

  for (const previousClaimValue of [[], 'x']) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({ ...baseInput, previousClaim: previousClaimValue }), TypeError);
  }
  assert.throws(() => deriveStripeSubscriptionEntitlement({
    ...baseInput,
    previousClaim: previousClaim({ subscriptionId: 'sub_other' }),
  }), TypeError);
  assert.throws(() => deriveStripeSubscriptionEntitlement({
    ...baseInput,
    previousClaim: previousClaim({ entitled: 'true' }),
  }), TypeError);
  assert.throws(() => deriveStripeSubscriptionEntitlement({
    ...baseInput,
    previousClaim: previousClaim({ entitled: true, validUntilSec: null }),
  }), TypeError);
  for (const sourceObservationId of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({
      ...baseInput,
      previousClaim: previousClaim({ sourceObservationId }),
    }), TypeError);
  }
  for (const sourceInvoiceId of ['', ' ', 'x'.repeat(256)]) {
    assert.throws(() => deriveStripeSubscriptionEntitlement({
      ...baseInput,
      previousClaim: previousClaim({ sourceInvoiceId }),
    }), TypeError);
  }

  const inactivePrevious = previousClaim({ entitled: false, validUntilSec: null, sourceInvoiceId: null });
  assert.equal(deriveStripeSubscriptionEntitlement({
    subscription: subscription({ status: 'canceled' }),
    previousClaim: inactivePrevious,
    nowSec: NOW,
  }).action, 'deny');

  assert.equal(deriveStripeSubscriptionEntitlement({
    subscription: subscription({ status: 'trialing', trialEndSec: NOW + 3_600, latestInvoiceId: null }),
    previousClaim: previousClaim({ validUntilSec: NOW + 7_200 }),
    nowSec: NOW,
  }).action, 'retain');

  assert.equal(deriveStripeSubscriptionEntitlement({
    subscription: subscription({ currentPeriodEndSec: NOW + 3_600 }),
    invoice: paidInvoice(),
    previousClaim: previousClaim({ validUntilSec: NOW + 7_200 }),
    nowSec: NOW,
  }).action, 'retain');

  assert.equal(deriveStripeSubscriptionEntitlement({
    subscription: subscription({ status: 'active' }),
    previousClaim: previousClaim({ validUntilSec: NOW }),
    nowSec: NOW,
  }).action, 'deny');

  for (const input of [null, [], 'x']) {
    assert.throws(() => deriveOrganizationStripeEntitlement(input), TypeError);
  }
  assert.throws(() => deriveOrganizationStripeEntitlement({ organizationId: 42, nowSec: NOW, claims: null }), TypeError);
  for (const organizationId of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveOrganizationStripeEntitlement({ organizationId, nowSec: NOW, claims: [] }), TypeError);
  }
  for (const nowSec of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveOrganizationStripeEntitlement({ organizationId: 42, nowSec, claims: [] }), TypeError);
  }
  for (const claim of [null, [], 'x']) {
    assert.throws(() => deriveOrganizationStripeEntitlement({ organizationId: 42, nowSec: NOW, claims: [claim] }), TypeError);
  }
  for (const badClaim of [
    { organizationId: 42, subscriptionId: '', entitled: false, validUntilSec: null },
    { organizationId: 42, subscriptionId: 'sub_ok', entitled: 'true', validUntilSec: null },
    { organizationId: 42, subscriptionId: 'sub_ok', entitled: true, validUntilSec: null },
    { organizationId: 42, subscriptionId: 'sub_ok', entitled: false, validUntilSec: -1 },
  ]) {
    assert.throws(() => deriveOrganizationStripeEntitlement({ organizationId: 42, nowSec: NOW, claims: [badClaim] }), TypeError);
  }
});

test('active subscription without a latest invoice identifier remains non-provisioning', () => {
  const denied = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ latestInvoiceId: null }),
    invoice: paidInvoice(),
    nowSec: NOW,
  });
  assert.equal(denied.action, 'deny');
  assert.equal(denied.reason, 'paid_invoice_evidence_required');
});

test('expired trial without prior access is denied rather than revoked', () => {
  const denied = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ status: 'trialing', trialEndSec: NOW, latestInvoiceId: null }),
    nowSec: NOW,
  });
  assert.equal(denied.action, 'deny');
  assert.equal(denied.reason, 'trial_not_usable');
});
