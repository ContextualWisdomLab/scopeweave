import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileStripeBillingAuthoritatively } from '../../server/stripe_billing_reconciliation.mjs';

function subscriptionSnapshot(overrides = {}) {
  return Object.freeze({
    organizationId: 42,
    subscriptionId: 'sub_scopeweave',
    customerId: 'cus_scopeweave',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodStartSec: 1_800_000_000,
    currentPeriodEndSec: 1_802_592_000,
    canceledAtSec: null,
    endedAtSec: null,
    trialEndSec: null,
    latestInvoiceId: 'in_scopeweave',
    priceIds: Object.freeze(['price_scopeweave']),
    ...overrides,
  });
}

function invoiceSnapshot(overrides = {}) {
  return Object.freeze({
    organizationId: 42,
    invoiceId: 'in_scopeweave',
    subscriptionId: 'sub_scopeweave',
    customerId: 'cus_scopeweave',
    status: 'paid',
    paid: true,
    currency: 'krw',
    amountDue: 19_900,
    amountPaid: 19_900,
    amountRemaining: 0,
    createdSec: 1_800_000_010,
    paidAtSec: 1_800_000_020,
    ...overrides,
  });
}

function baseDependencies(overrides = {}) {
  const calls = [];
  const subscription = subscriptionSnapshot();
  const invoice = invoiceSnapshot();

  const dependencies = {
    fetchSubscription: async (authority) => {
      calls.push(['fetch-subscription', authority.organizationId, authority.subscriptionId]);
      return subscription;
    },
    fetchInvoice: async (authority) => {
      calls.push(['fetch-invoice', authority.organizationId, authority.invoiceId, authority.subscriptionId, authority.customerId]);
      return invoice;
    },
    subscriptionRepository: {
      recordAuthoritativeObservation(input) {
        calls.push(['record-subscription', input.sourceEventId]);
        assert.equal(input.snapshot, subscription);
        return Object.freeze({
          observationId: 101,
          subscriptionId: subscription.subscriptionId,
          observedAtMs: 1_800_000_000_000,
        });
      },
    },
    invoiceRepository: {
      recordAuthoritativeObservation(input) {
        calls.push(['record-invoice', input.sourceSubscriptionObservationId, input.sourceEventId]);
        assert.equal(input.snapshot, invoice);
        return Object.freeze({
          observationId: 201,
          invoiceId: invoice.invoiceId,
          observedAtMs: 1_800_000_000_100,
          sourceSubscriptionObservationId: input.sourceSubscriptionObservationId,
        });
      },
    },
    claimRepository: {
      getCurrentClaim(input) {
        calls.push(['get-claim', input.organizationId, input.subscriptionId]);
        return Object.freeze({ decisionId: 301 });
      },
      applyCurrentDecision(input) {
        calls.push(['apply-claim', input.organizationId, input.subscriptionId, input.expectedPreviousDecisionId]);
        return Object.freeze({
          decisionId: 302,
          organizationId: input.organizationId,
          subscriptionId: input.subscriptionId,
          entitled: true,
          validUntilSec: 1_802_592_000,
        });
      },
    },
    ...overrides,
  };

  return { dependencies, calls, subscription, invoice };
}

test('authoritative reconciliation reads current provider state before recording evidence and claim authority', async () => {
  const { dependencies, calls } = baseDependencies();

  const result = await reconcileStripeBillingAuthoritatively({
    organizationId: 42,
    subscriptionId: 'sub_scopeweave',
    sourceEventId: 'evt_older_delivery',
    ...dependencies,
  });

  assert.deepEqual(calls, [
    ['fetch-subscription', 42, 'sub_scopeweave'],
    ['record-subscription', 'evt_older_delivery'],
    ['fetch-invoice', 42, 'in_scopeweave', 'sub_scopeweave', 'cus_scopeweave'],
    ['record-invoice', 101, 'evt_older_delivery'],
    ['get-claim', 42, 'sub_scopeweave'],
    ['apply-claim', 42, 'sub_scopeweave', 301],
  ]);
  assert.deepEqual(result, {
    organizationId: 42,
    subscriptionId: 'sub_scopeweave',
    subscriptionObservationId: 101,
    invoiceObservationId: 201,
    claimDecisionId: 302,
  });
  assert.equal(Object.isFrozen(result), true);
});

test('event arrival order is provenance only: each trigger re-reads current Subscription and Invoice authority', async () => {
  const calls = [];
  let providerVersion = 0;
  const currentSubscription = subscriptionSnapshot();
  const currentInvoice = invoiceSnapshot();

  const common = {
    organizationId: 42,
    subscriptionId: 'sub_scopeweave',
    fetchSubscription: async () => {
      providerVersion += 1;
      calls.push(`subscription-${providerVersion}`);
      return currentSubscription;
    },
    fetchInvoice: async () => {
      calls.push(`invoice-${providerVersion}`);
      return currentInvoice;
    },
    subscriptionRepository: {
      recordAuthoritativeObservation({ sourceEventId }) {
        calls.push(`subscription-evidence-${sourceEventId}`);
        return Object.freeze({ observationId: providerVersion * 10, subscriptionId: 'sub_scopeweave', observedAtMs: providerVersion });
      },
    },
    invoiceRepository: {
      recordAuthoritativeObservation({ sourceSubscriptionObservationId, sourceEventId }) {
        calls.push(`invoice-evidence-${sourceEventId}`);
        return Object.freeze({ observationId: sourceSubscriptionObservationId + 1, invoiceId: 'in_scopeweave', observedAtMs: providerVersion, sourceSubscriptionObservationId });
      },
    },
    claimRepository: {
      getCurrentClaim() {
        return providerVersion === 1 ? null : Object.freeze({ decisionId: 900 + providerVersion - 1 });
      },
      applyCurrentDecision({ expectedPreviousDecisionId }) {
        calls.push(`claim-${String(expectedPreviousDecisionId)}`);
        return Object.freeze({ decisionId: 900 + providerVersion });
      },
    },
  };

  const newer = await reconcileStripeBillingAuthoritatively({ ...common, sourceEventId: 'evt_newer' });
  const older = await reconcileStripeBillingAuthoritatively({ ...common, sourceEventId: 'evt_older' });

  assert.equal(newer.claimDecisionId, 901);
  assert.equal(older.claimDecisionId, 902);
  assert.deepEqual(calls, [
    'subscription-1',
    'subscription-evidence-evt_newer',
    'invoice-1',
    'invoice-evidence-evt_newer',
    'claim-null',
    'subscription-2',
    'subscription-evidence-evt_older',
    'invoice-2',
    'invoice-evidence-evt_older',
    'claim-901',
  ]);
});

test('reconciliation omits Invoice I/O when the authoritative Subscription has no latest Invoice', async () => {
  const { dependencies, calls } = baseDependencies({
    fetchSubscription: async () => subscriptionSnapshot({ latestInvoiceId: null }),
    fetchInvoice: async () => assert.fail('Invoice provider must not be called without latestInvoiceId'),
    invoiceRepository: {
      recordAuthoritativeObservation() {
        assert.fail('Invoice evidence must not be recorded without latestInvoiceId');
      },
    },
  });

  const result = await reconcileStripeBillingAuthoritatively({
    organizationId: 42,
    subscriptionId: 'sub_scopeweave',
    sourceEventId: null,
    ...dependencies,
  });

  assert.equal(result.invoiceObservationId, null);
  assert.equal(result.claimDecisionId, 302);
  assert.equal(calls.some(([name]) => name === 'record-invoice'), false);
});

test('one optimistic-claim conflict refreshes the current head and retries only the claim decision', async () => {
  const { dependencies, calls } = baseDependencies();
  let claimReads = 0;
  let claimWrites = 0;
  dependencies.claimRepository = {
    getCurrentClaim() {
      claimReads += 1;
      return Object.freeze({ decisionId: claimReads === 1 ? 10 : 11 });
    },
    applyCurrentDecision({ expectedPreviousDecisionId }) {
      claimWrites += 1;
      if (claimWrites === 1) {
        const error = new Error('concurrent claim');
        error.code = 'stripe_entitlement_claim_conflict';
        throw error;
      }
      assert.equal(expectedPreviousDecisionId, 11);
      return Object.freeze({ decisionId: 12 });
    },
  };

  const result = await reconcileStripeBillingAuthoritatively({
    organizationId: 42,
    subscriptionId: 'sub_scopeweave',
    sourceEventId: 'evt_concurrent',
    ...dependencies,
  });

  assert.equal(result.claimDecisionId, 12);
  assert.equal(claimReads, 2);
  assert.equal(claimWrites, 2);
  assert.equal(calls.filter(([name]) => name === 'fetch-subscription').length, 1);
  assert.equal(calls.filter(([name]) => name === 'fetch-invoice').length, 1);
});

test('a second optimistic-claim conflict is bounded and propagated instead of looping', async () => {
  const { dependencies } = baseDependencies();
  let writes = 0;
  dependencies.claimRepository = {
    getCurrentClaim() {
      return Object.freeze({ decisionId: 77 + writes });
    },
    applyCurrentDecision() {
      writes += 1;
      const error = new Error('still concurrent');
      error.code = 'stripe_entitlement_claim_conflict';
      throw error;
    },
  };

  await assert.rejects(
    reconcileStripeBillingAuthoritatively({
      organizationId: 42,
      subscriptionId: 'sub_scopeweave',
      ...dependencies,
    }),
    (error) => error.code === 'stripe_entitlement_claim_conflict',
  );
  assert.equal(writes, 2);
});

test('non-conflict claim failures preserve the causal error and are not retried', async () => {
  const { dependencies } = baseDependencies();
  const causal = new Error('persistence unavailable');
  causal.code = 'stripe_entitlement_claim_invalid';
  let writes = 0;
  dependencies.claimRepository = {
    getCurrentClaim() {
      return null;
    },
    applyCurrentDecision() {
      writes += 1;
      throw causal;
    },
  };

  await assert.rejects(
    reconcileStripeBillingAuthoritatively({
      organizationId: 42,
      subscriptionId: 'sub_scopeweave',
      ...dependencies,
    }),
    (error) => error === causal,
  );
  assert.equal(writes, 1);
});

test('invalid local authority or missing persistence ports fail before provider I/O', async () => {
  let providerCalls = 0;
  const fetchSubscription = async () => {
    providerCalls += 1;
    return subscriptionSnapshot();
  };

  await assert.rejects(
    reconcileStripeBillingAuthoritatively({
      organizationId: 0,
      subscriptionId: 'sub_scopeweave',
      fetchSubscription,
      fetchInvoice: async () => invoiceSnapshot(),
      subscriptionRepository: {},
      invoiceRepository: {},
      claimRepository: {},
    }),
    TypeError,
  );
  await assert.rejects(
    reconcileStripeBillingAuthoritatively({
      organizationId: 42,
      subscriptionId: 'not-a-subscription',
      fetchSubscription,
      fetchInvoice: async () => invoiceSnapshot(),
      subscriptionRepository: {},
      invoiceRepository: {},
      claimRepository: {},
    }),
    TypeError,
  );
  await assert.rejects(
    reconcileStripeBillingAuthoritatively({
      organizationId: 42,
      subscriptionId: 'sub_scopeweave',
      fetchSubscription,
      fetchInvoice: async () => invoiceSnapshot(),
      subscriptionRepository: {},
      invoiceRepository: {},
      claimRepository: {},
    }),
    TypeError,
  );
  assert.equal(providerCalls, 0);
});
