import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StripeWebhookReconciliationTriggerError,
  triggerStripeBillingReconciliationFromVerifiedEvent,
} from '../../server/stripe_webhook_reconciliation_trigger.mjs';

const subscriptionEvent = ({
  id = 'evt_sub',
  type = 'customer.subscription.updated',
  subscriptionId = 'sub_local',
  orgId = '7',
} = {}) => ({
  id,
  type,
  data: { object: { id: subscriptionId, metadata: orgId == null ? {} : { orgId } } },
});

const checkoutEvent = ({
  id = 'evt_checkout',
  sessionId = 'cs_local',
  subscriptionId = 'sub_local',
  orgId = '7',
} = {}) => ({
  id,
  type: 'checkout.session.completed',
  data: { object: {
    id: sessionId,
    mode: 'subscription',
    subscription: subscriptionId,
    metadata: orgId == null ? {} : { orgId },
  } },
});

const invoiceEvent = ({
  id = 'evt_invoice',
  type = 'invoice.paid',
  subscriptionId = 'sub_local',
  orgId = '7',
  legacySubscription,
} = {}) => ({
  id,
  type,
  data: { object: {
    id: 'in_local',
    ...(legacySubscription === undefined ? {} : { subscription: legacySubscription }),
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: subscriptionId,
        metadata: orgId == null ? {} : { orgId },
      },
    },
  } },
});

function harness({
  checkoutAuthority = { organizationId: 7, providerSessionId: 'cs_local' },
  subscriptionAuthority = { organizationId: 7, subscriptionId: 'sub_local' },
} = {}) {
  const calls = [];
  return {
    calls,
    resolveCheckoutSessionAuthority: (sessionId) => {
      calls.push(['checkout', sessionId]);
      return checkoutAuthority;
    },
    resolveSubscriptionAuthority: (subscriptionId) => {
      calls.push(['subscription', subscriptionId]);
      return subscriptionAuthority;
    },
    reconcileBilling: async (input) => {
      calls.push(['reconcile', input]);
      return { decisionId: 42 };
    },
  };
}

test('ignores unrelated verified Stripe events without touching authority ports', async () => {
  const h = harness();
  const result = await triggerStripeBillingReconciliationFromVerifiedEvent({
    event: { id: 'evt_product', type: 'product.updated', data: { object: { id: 'prod_1' } } },
    ...h,
  });
  assert.deepEqual(result, { outcome: 'ignored' });
  assert.deepEqual(h.calls, []);
});

test('bootstraps reconciliation from a completed locally-owned Checkout Session', async () => {
  const h = harness();
  const result = await triggerStripeBillingReconciliationFromVerifiedEvent({ event: checkoutEvent(), ...h });
  assert.deepEqual(result, { outcome: 'reconciled' });
  assert.deepEqual(h.calls, [
    ['checkout', 'cs_local'],
    ['reconcile', { organizationId: 7, subscriptionId: 'sub_local', sourceEventId: 'evt_checkout' }],
  ]);
});

test('never uses Checkout metadata as tenant authority when the durable attempt is absent', async () => {
  const h = harness({ checkoutAuthority: null });
  await assert.rejects(
    triggerStripeBillingReconciliationFromVerifiedEvent({ event: checkoutEvent(), ...h }),
    (error) => error instanceof StripeWebhookReconciliationTriggerError
      && error.code === 'stripe_webhook_reconciliation_deferred'
      && error.status === 503,
  );
  assert.deepEqual(h.calls, [['checkout', 'cs_local']]);
});

test('ignores a completed subscription Checkout Session that has no ScopeWeave ownership signal', async () => {
  const h = harness({ checkoutAuthority: null });
  const result = await triggerStripeBillingReconciliationFromVerifiedEvent({
    event: checkoutEvent({ orgId: null }),
    ...h,
  });
  assert.deepEqual(result, { outcome: 'ignored' });
  assert.deepEqual(h.calls, [['checkout', 'cs_local']]);
});

test('rejects a Checkout metadata contradiction against durable local attempt authority', async () => {
  const h = harness();
  await assert.rejects(
    triggerStripeBillingReconciliationFromVerifiedEvent({ event: checkoutEvent({ orgId: '8' }), ...h }),
    (error) => error instanceof StripeWebhookReconciliationTriggerError
      && error.code === 'stripe_webhook_reconciliation_deferred',
  );
  assert.deepEqual(h.calls, [['checkout', 'cs_local']]);
});

test('uses durable Subscription ownership for customer.subscription events', async () => {
  const h = harness();
  const result = await triggerStripeBillingReconciliationFromVerifiedEvent({
    event: subscriptionEvent({ orgId: '999' }),
    ...h,
  });
  assert.deepEqual(result, { outcome: 'reconciled' });
  assert.deepEqual(h.calls, [
    ['subscription', 'sub_local'],
    ['reconcile', { organizationId: 7, subscriptionId: 'sub_local', sourceEventId: 'evt_sub' }],
  ]);
});

test('defers a ScopeWeave-marked Subscription event until durable authority exists', async () => {
  const h = harness({ subscriptionAuthority: null });
  await assert.rejects(
    triggerStripeBillingReconciliationFromVerifiedEvent({ event: subscriptionEvent(), ...h }),
    (error) => error instanceof StripeWebhookReconciliationTriggerError
      && error.code === 'stripe_webhook_reconciliation_deferred',
  );
  assert.deepEqual(h.calls, [['subscription', 'sub_local']]);
});

test('uses current Basil Invoice subscription provenance with durable Subscription authority', async () => {
  const h = harness();
  const result = await triggerStripeBillingReconciliationFromVerifiedEvent({ event: invoiceEvent(), ...h });
  assert.deepEqual(result, { outcome: 'reconciled' });
  assert.deepEqual(h.calls, [
    ['subscription', 'sub_local'],
    ['reconcile', { organizationId: 7, subscriptionId: 'sub_local', sourceEventId: 'evt_invoice' }],
  ]);
});

test('accepts legacy Invoice subscription provenance when the current parent shape is absent', async () => {
  const h = harness();
  const event = invoiceEvent({ subscriptionId: null, orgId: null, legacySubscription: 'sub_local' });
  delete event.data.object.parent;
  const result = await triggerStripeBillingReconciliationFromVerifiedEvent({ event, ...h });
  assert.deepEqual(result, { outcome: 'reconciled' });
});

test('fails closed when current and legacy Invoice subscription identities disagree', async () => {
  const h = harness();
  await assert.rejects(
    triggerStripeBillingReconciliationFromVerifiedEvent({
      event: invoiceEvent({ subscriptionId: 'sub_local', legacySubscription: 'sub_other' }),
      ...h,
    }),
    (error) => error instanceof StripeWebhookReconciliationTriggerError
      && error.code === 'stripe_webhook_reconciliation_deferred',
  );
  assert.deepEqual(h.calls, []);
});

test('defers a ScopeWeave-marked Invoice until its durable Subscription link exists', async () => {
  const h = harness({ subscriptionAuthority: null });
  await assert.rejects(
    triggerStripeBillingReconciliationFromVerifiedEvent({ event: invoiceEvent(), ...h }),
    (error) => error instanceof StripeWebhookReconciliationTriggerError
      && error.code === 'stripe_webhook_reconciliation_deferred',
  );
  assert.deepEqual(h.calls, [['subscription', 'sub_local']]);
});

test('rejects malformed authority-port identities before reconciliation', async () => {
  const h = harness({ subscriptionAuthority: { organizationId: 7, subscriptionId: 'sub_other' } });
  await assert.rejects(
    triggerStripeBillingReconciliationFromVerifiedEvent({ event: subscriptionEvent(), ...h }),
    (error) => error instanceof StripeWebhookReconciliationTriggerError,
  );
  assert.deepEqual(h.calls, [['subscription', 'sub_local']]);
});
