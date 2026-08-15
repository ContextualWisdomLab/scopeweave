import test from 'node:test';
import assert from 'node:assert/strict';

import { createCheckout } from '../../server/billing.mjs';

const disabledConfiguration = { mode: 'disabled', publicOrigin: null };
const mockConfiguration = { mode: 'mock', publicOrigin: 'http://127.0.0.1:8787' };
const liveConfiguration = { mode: 'live', publicOrigin: 'https://planner.example.com' };

test('unconfigured production checkout fails closed with actionable HTTP 503', async () => {
  let rejectedError;
  await assert.rejects(
    createCheckout({ orgId: 42, configuration: disabledConfiguration }),
    (error) => {
      rejectedError = error;
      assert.equal(error.status, 503);
      assert.equal(typeof error.getResponse, 'function');
      return true;
    },
  );

  const response = rejectedError.getResponse();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=UTF-8');
  const payload = await response.json();
  assert.equal(payload.error, 'billing_not_configured');
  assert.match(payload.action, /Configure the complete Stripe billing settings/);
});

test('development mock uses only the operator-owned public origin', async () => {
  const checkout = await createCheckout({
    orgId: 'org /?#42',
    origin: 'https://attacker.example',
    configuration: mockConfiguration,
  });

  assert.deepEqual(checkout, {
    url: 'http://127.0.0.1:8787/?billing=mock&org=org%20%2F%3F%2342',
    live: false,
    mock: true,
  });
  assert.doesNotMatch(checkout.url, /attacker\.example/);
});

test('live checkout builds redirects from canonical configuration and preserves server identity', async () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  process.env.STRIPE_SECRET_KEY = 'sk_test_trusted';
  process.env.STRIPE_PRICE_ID = 'price_trusted';

  const calls = [];
  const fakeStripeClientFactory = async (secretKey) => {
    assert.equal(secretKey, 'sk_test_trusted');
    return {
      checkout: {
        sessions: {
          async create(payload) {
            calls.push(payload);
            return { url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
          },
        },
      },
    };
  };

  try {
    const checkout = await createCheckout({
      orgId: 73,
      origin: 'https://attacker.example',
      configuration: liveConfiguration,
      stripeClientFactory: fakeStripeClientFactory,
    });

    assert.deepEqual(checkout, {
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      live: true,
    });
    assert.deepEqual(calls, [{
      mode: 'subscription',
      line_items: [{ price: 'price_trusted', quantity: 1 }],
      success_url: 'https://planner.example.com/?billing=success',
      cancel_url: 'https://planner.example.com/?billing=cancel',
      client_reference_id: '73',
      metadata: { orgId: '73' },
    }]);
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
});
