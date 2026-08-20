import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileStripeBillingAuthoritatively } from '../../server/stripe_billing_reconciliation.mjs';

function subscriptionSnapshot() {
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
  });
}

function invoiceSnapshot() {
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
  });
}

function dependencies(overrides = {}) {
  return {
    fetchSubscription: async () => subscriptionSnapshot(),
    fetchInvoice: async () => invoiceSnapshot(),
    subscriptionRepository: {
      recordAuthoritativeObservation() {
        return Object.freeze({
          observationId: 101,
          subscriptionId: 'sub_scopeweave',
          observedAtMs: 1_800_000_000_000,
        });
      },
    },
    invoiceRepository: {
      recordAuthoritativeObservation() {
        return Object.freeze({
          observationId: 201,
          invoiceId: 'in_scopeweave',
          observedAtMs: 1_800_000_000_100,
          sourceSubscriptionObservationId: 101,
        });
      },
    },
    claimRepository: {
      getCurrentClaim() {
        return Object.freeze({
          decisionId: 301,
          organizationId: 42,
          subscriptionId: 'sub_scopeweave',
        });
      },
      applyCurrentDecision() {
        return Object.freeze({
          decisionId: 302,
          organizationId: 42,
          subscriptionId: 'sub_scopeweave',
        });
      },
    },
    ...overrides,
  };
}

async function reconcile(overrides = {}) {
  return reconcileStripeBillingAuthoritatively({
    organizationId: 42,
    subscriptionId: 'sub_scopeweave',
    sourceEventId: 'evt_integrity',
    ...dependencies(overrides),
  });
}

test('subscription evidence identity cannot be substituted by a persistence port', async () => {
  let invoiceCalls = 0;
  let claimCalls = 0;
  await assert.rejects(
    reconcile({
      subscriptionRepository: {
        recordAuthoritativeObservation() {
          return Object.freeze({
            observationId: 101,
            subscriptionId: 'sub_other_tenant',
            observedAtMs: 1_800_000_000_000,
          });
        },
      },
      fetchInvoice: async () => {
        invoiceCalls += 1;
        return invoiceSnapshot();
      },
      claimRepository: {
        getCurrentClaim() {
          claimCalls += 1;
          return null;
        },
        applyCurrentDecision() {
          claimCalls += 1;
          return Object.freeze({ decisionId: 302, organizationId: 42, subscriptionId: 'sub_scopeweave' });
        },
      },
    }),
    TypeError,
  );
  assert.equal(invoiceCalls, 0);
  assert.equal(claimCalls, 0);
});

test('invoice evidence identity and source observation cannot be substituted by a persistence port', async () => {
  for (const badEvidence of [
    Object.freeze({ observationId: 201, invoiceId: 'in_other', sourceSubscriptionObservationId: 101 }),
    Object.freeze({ observationId: 201, invoiceId: 'in_scopeweave', sourceSubscriptionObservationId: 999 }),
  ]) {
    let claimCalls = 0;
    await assert.rejects(
      reconcile({
        invoiceRepository: {
          recordAuthoritativeObservation() {
            return badEvidence;
          },
        },
        claimRepository: {
          getCurrentClaim() {
            claimCalls += 1;
            return null;
          },
          applyCurrentDecision() {
            claimCalls += 1;
            return Object.freeze({ decisionId: 302, organizationId: 42, subscriptionId: 'sub_scopeweave' });
          },
        },
      }),
      TypeError,
    );
    assert.equal(claimCalls, 0);
  }
});

test('current and newly applied claims must remain bound to the requested tenant and Subscription', async () => {
  await assert.rejects(
    reconcile({
      claimRepository: {
        getCurrentClaim() {
          return Object.freeze({ decisionId: 301, organizationId: 7, subscriptionId: 'sub_scopeweave' });
        },
        applyCurrentDecision() {
          assert.fail('a foreign current claim must fail before claim application');
        },
      },
    }),
    TypeError,
  );

  await assert.rejects(
    reconcile({
      claimRepository: {
        getCurrentClaim() {
          return Object.freeze({ decisionId: 301, organizationId: 42, subscriptionId: 'sub_scopeweave' });
        },
        applyCurrentDecision() {
          return Object.freeze({ decisionId: 302, organizationId: 42, subscriptionId: 'sub_other_tenant' });
        },
      },
    }),
    TypeError,
  );
});
