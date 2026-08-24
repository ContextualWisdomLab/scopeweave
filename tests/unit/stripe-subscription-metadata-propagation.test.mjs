import test from 'node:test';
import assert from 'node:assert/strict';

import { createCheckout } from '../../server/billing.mjs';

const liveConfiguration = { mode: 'live', publicOrigin: 'https://planner.example.com' };

function attemptRepository() {
  return {
    startAttempt() {
      return {
        attemptId: 'attempt-subscription-metadata',
        idempotencyKey: 'idem-subscription-metadata',
        state: 'pending',
        reused: false,
      };
    },
    markProviderSucceeded() {},
    markProviderFailed() {},
  };
}

async function withStripeEnv(run) {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  const previousFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = 'sk_test_subscription_metadata';
  process.env.STRIPE_PRICE_ID = 'price_subscription_metadata';
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
}

test('subscription Checkout carries the organization binding onto the created Stripe Subscription', async () => {
  await withStripeEnv(async () => {
    let observedPayload;
    let observedOptions;
    const result = await createCheckout({
      orgId: 73,
      configuration: liveConfiguration,
      attemptRepository: attemptRepository(),
      stripeClientFactory: async () => ({
        checkout: {
          sessions: {
            async create(payload, options) {
              observedPayload = payload;
              observedOptions = options;
              return {
                id: 'cs_test_subscription_metadata',
                url: 'https://checkout.stripe.com/c/pay/cs_test_subscription_metadata',
              };
            },
          },
        },
      }),
    });

    assert.equal(result.live, true);
    assert.equal(observedPayload.client_reference_id, '73');
    assert.deepEqual(observedPayload.metadata, { orgId: '73' });
    assert.deepEqual(observedPayload.subscription_data, {
      metadata: { orgId: '73' },
    });
    assert.deepEqual(observedOptions, {
      idempotencyKey: 'idem-subscription-metadata',
    });
  });
});

test('direct Checkout form sends the tenant binding to the Stripe Subscription transport field', async () => {
  await withStripeEnv(async () => {
    let observedBody;
    globalThis.fetch = async (_url, options) => {
      observedBody = options.body;
      return new Response(JSON.stringify({
        id: 'cs_test_direct_subscription_metadata',
        url: 'https://checkout.stripe.com/c/pay/cs_test_direct_subscription_metadata',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await createCheckout({
      orgId: 73,
      configuration: liveConfiguration,
      attemptRepository: attemptRepository(),
    });

    assert.equal(result.live, true);
    const form = new URLSearchParams(observedBody);
    assert.equal(form.get('metadata[orgId]'), '73');
    assert.equal(form.get('subscription_data[metadata][orgId]'), '73');
  });
});
