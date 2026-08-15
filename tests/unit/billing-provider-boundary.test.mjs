import test from 'node:test';
import assert from 'node:assert/strict';

import { createCheckout } from '../../server/billing.mjs';

const liveConfiguration = { mode: 'live', publicOrigin: 'https://planner.example.com' };

async function withStripeEnv(run) {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  process.env.STRIPE_SECRET_KEY = 'sk_test_provider_boundary';
  process.env.STRIPE_PRICE_ID = 'price_provider_boundary';
  try {
    await run();
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
}

async function expectProviderError(run, expectedCode) {
  let rejectedError;
  await assert.rejects(run, (error) => {
    rejectedError = error;
    assert.equal(error.status, 502);
    assert.equal(typeof error.getResponse, 'function');
    return true;
  });
  const response = rejectedError.getResponse();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.equal(payload.error, expectedCode);
  assert.equal(typeof payload.action, 'string');
  assert.ok(payload.action.length > 0);
  return JSON.stringify(payload);
}

test('live Checkout uses a bounded single-attempt Stripe request', async () => {
  await withStripeEnv(async () => {
    const observed = [];
    const stripeClientFactory = async (secretKey, clientOptions) => {
      observed.push({ secretKey, clientOptions });
      return {
        checkout: {
          sessions: {
            async create(payload, requestOptions) {
              observed.push({ payload, requestOptions });
              return { url: 'https://checkout.stripe.com/c/pay/cs_test_boundary' };
            },
          },
        },
      };
    };

    const result = await createCheckout({
      orgId: 73,
      configuration: liveConfiguration,
      stripeClientFactory,
    });

    assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_boundary');
    assert.deepEqual(observed[0], {
      secretKey: 'sk_test_provider_boundary',
      clientOptions: { maxNetworkRetries: 0, timeout: 15000 },
    });
    assert.deepEqual(observed[1].requestOptions, { maxNetworkRetries: 0, timeout: 15000 });
  });
});

test('live Checkout rejects malformed or untrusted provider destinations', async () => {
  const invalidUrls = [
    null,
    '',
    'not a URL',
    'http://checkout.stripe.com/c/pay/cs_test_plaintext',
    'https://user:pass@checkout.stripe.com/c/pay/cs_test_credentials',
    'https://checkout.stripe.com.evil.example/c/pay/cs_test_suffix',
    'https://checkout.stripe.com:444/c/pay/cs_test_port',
    'https://checkout.stripe.com/c/pay/cs_test_fragment#credential',
  ];

  await withStripeEnv(async () => {
    for (const url of invalidUrls) {
      const stripeClientFactory = async () => ({
        checkout: { sessions: { async create() { return { url }; } } },
      });
      await expectProviderError(
        () => createCheckout({ orgId: 73, configuration: liveConfiguration, stripeClientFactory }),
        'billing_provider_invalid_response',
      );
    }
  });
});

test('provider failures become a stable sanitized buyer-facing error', async () => {
  await withStripeEnv(async () => {
    const stripeClientFactory = async () => ({
      checkout: {
        sessions: {
          async create() {
            throw new Error('dial tcp 10.7.0.12:443 with sk_live_should_not_escape');
          },
        },
      },
    });

    const payload = await expectProviderError(
      () => createCheckout({ orgId: 73, configuration: liveConfiguration, stripeClientFactory }),
      'billing_provider_unavailable',
    );
    assert.doesNotMatch(payload, /10\.7\.0\.12|sk_live_should_not_escape/);
  });
});
