import test from 'node:test';
import assert from 'node:assert/strict';

import { createCheckout } from '../../server/billing.mjs';

const disabledConfiguration = { mode: 'disabled', publicOrigin: null };
const mockConfiguration = { mode: 'mock', publicOrigin: 'http://127.0.0.1:8787' };
const liveConfiguration = { mode: 'live', publicOrigin: 'https://planner.example.com' };

async function withDefaultStripeTransport(responseFactory, assertion) {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  const previousFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = 'sk_test_default_transport';
  process.env.STRIPE_PRICE_ID = 'price_default_transport';
  globalThis.fetch = responseFactory;

  try {
    await assertion();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
}

async function expectSafeProviderFailure(responseFactory) {
  await withDefaultStripeTransport(responseFactory, async () => {
    let rejectedError;
    await assert.rejects(
      createCheckout({ orgId: 91, configuration: liveConfiguration }),
      (error) => {
        rejectedError = error;
        assert.equal(error.status, 502);
        assert.equal(typeof error.getResponse, 'function');
        return true;
      },
    );

    const response = rejectedError.getResponse();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=UTF-8');
    const payload = await response.json();
    assert.deepEqual(payload, {
      error: 'billing_provider_unavailable',
      action: 'Checkout could not be started. Retry later; if the problem persists, contact your ScopeWeave operator.',
    });
  });
}

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

test('default live provider transport uses Stripe HTTPS without an undeclared runtime SDK', async () => {
  const calls = [];
  await withDefaultStripeTransport(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      url: 'https://checkout.stripe.com/c/pay/cs_test_default_transport',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }, async () => {
    const checkout = await createCheckout({
      orgId: 91,
      origin: 'https://attacker.example',
      configuration: liveConfiguration,
    });

    assert.deepEqual(checkout, {
      url: 'https://checkout.stripe.com/c/pay/cs_test_default_transport',
      live: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.redirect, 'error');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.headers.authorization, 'Bearer sk_test_default_transport');
    assert.equal(calls[0].options.headers['content-type'], 'application/x-www-form-urlencoded');

    const form = new URLSearchParams(calls[0].options.body);
    assert.equal(form.get('mode'), 'subscription');
    assert.equal(form.get('line_items[0][price]'), 'price_default_transport');
    assert.equal(form.get('line_items[0][quantity]'), '1');
    assert.equal(form.get('success_url'), 'https://planner.example.com/?billing=success');
    assert.equal(form.get('cancel_url'), 'https://planner.example.com/?billing=cancel');
    assert.equal(form.get('client_reference_id'), '91');
    assert.equal(form.get('metadata[orgId]'), '91');
  });
});

test('default live provider transport rejects non-2xx Stripe responses with a safe retryable error', async () => {
  await expectSafeProviderFailure(async () => new Response(JSON.stringify({
    error: { message: 'No such price: price_secret_internal_detail' },
  }), {
    status: 400,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }));
});

test('default live provider transport rejects malformed successful session payloads', async () => {
  await expectSafeProviderFailure(async () => new Response(JSON.stringify({
    id: 'cs_test_missing_url',
    object: 'checkout.session',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }));

  await expectSafeProviderFailure(async () => new Response('{not-json', {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }));
});
