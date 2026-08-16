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

test('subscription Checkout carries the organization binding onto the created Stripe Subscription', async () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  process.env.STRIPE_SECRET_KEY = 'sk_test_subscription_metadata';
  process.env.STRIPE_PRICE_ID = 'price_subscription_metadata';

  let observedPayload;
  let observedOptions;
  try {
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
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
});
