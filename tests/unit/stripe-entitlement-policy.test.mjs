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

test('paid active subscription grants or extends only through its authoritative current period', () => {
  const granted = deriveStripeSubscriptionEntitlement({
    subscription: subscription(),
    invoice: paidInvoice(),
    nowSec: NOW,
  });
  assert.deepEqual(granted, {
    action: 'grant',
    reason: 'paid_active_subscription',
    claim: {
      organizationId: 42,
      subscriptionId: 'sub_scopeweave_42',
      entitled: true,
      validUntilSec: NOW + 2_592_000,
      sourceObservationId: 10,
      sourceInvoiceId: 'in_scopeweave_paid',
    },
  });

  const extended = deriveStripeSubscriptionEntitlement({
    subscription: subscription(),
    invoice: paidInvoice(),
    previousClaim: previousClaim(),
    nowSec: NOW,
  });
  assert.equal(extended.action, 'extend');
});

test('active status without exact paid invoice evidence never creates or extends access', () => {
  for (const invoice of [
    null,
    paidInvoice({ status: 'open' }),
    paidInvoice({ invoiceId: 'in_other' }),
    paidInvoice({ subscriptionId: 'sub_other' }),
  ]) {
    const denied = deriveStripeSubscriptionEntitlement({
      subscription: subscription(),
      invoice,
      nowSec: NOW,
    });
    assert.equal(denied.action, 'deny');
    assert.equal(denied.reason, 'paid_invoice_evidence_required');
    assert.equal(denied.claim.entitled, false);

    const retained = deriveStripeSubscriptionEntitlement({
      subscription: subscription(),
      invoice,
      previousClaim: previousClaim(),
      nowSec: NOW,
    });
    assert.equal(retained.action, 'retain');
    assert.equal(retained.claim.validUntilSec, NOW + 86_400);
  }
});

test('trialing and past_due never manufacture paid renewal authority', () => {
  const trial = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ status: 'trialing', trialEndSec: NOW + 3_600, latestInvoiceId: null }),
    nowSec: NOW,
  });
  assert.equal(trial.action, 'grant');
  assert.equal(trial.claim.validUntilSec, NOW + 3_600);

  const retained = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ status: 'past_due' }),
    invoice: paidInvoice(),
    previousClaim: previousClaim(),
    nowSec: NOW,
  });
  assert.equal(retained.action, 'retain');
  assert.equal(retained.reason, 'past_due_no_extension');
  assert.equal(retained.claim.validUntilSec, NOW + 86_400);

  const denied = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ status: 'past_due' }),
    invoice: paidInvoice(),
    nowSec: NOW,
  });
  assert.equal(denied.action, 'deny');
});

test('terminal or non-provisioning states revoke one subscription claim and stale observations cannot roll back newer evidence', () => {
  for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'paused', 'canceled']) {
    const result = deriveStripeSubscriptionEntitlement({
      subscription: subscription({ status }),
      previousClaim: previousClaim(),
      nowSec: NOW,
    });
    assert.equal(result.action, 'revoke');
    assert.equal(result.claim.entitled, false);
  }

  const newer = previousClaim({ sourceObservationId: 20, validUntilSec: NOW + 2_592_000, sourceInvoiceId: 'in_newer' });
  const stale = deriveStripeSubscriptionEntitlement({
    subscription: subscription({ observationId: 19, status: 'canceled' }),
    previousClaim: newer,
    nowSec: NOW,
  });
  assert.equal(stale.action, 'ignore');
  assert.deepEqual(stale.claim, newer);
});

test('organization aggregation preserves access when another subscription is canceled', () => {
  const result = deriveOrganizationStripeEntitlement({
    organizationId: 42,
    nowSec: NOW,
    claims: [
      { organizationId: 42, subscriptionId: 'sub_zeta', entitled: false, validUntilSec: null },
      { organizationId: 42, subscriptionId: 'sub_alpha', entitled: true, validUntilSec: NOW + 3_600 },
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
});
