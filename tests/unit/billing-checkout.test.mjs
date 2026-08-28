import test from 'node:test';
import assert from 'node:assert/strict';

import { createCheckout } from '../../server/billing.mjs';

const disabledConfiguration = { mode: 'disabled', publicOrigin: null };
const mockConfiguration = { mode: 'mock', publicOrigin: 'http://127.0.0.1:8787' };
const liveConfiguration = { mode: 'live', publicOrigin: 'https://planner.example.com' };
const providerFailurePayloads = Object.freeze({
  billing_provider_unavailable: {
    error: 'billing_provider_unavailable',
    action: 'Retry checkout. If the problem persists, verify Stripe connectivity and service health before retrying.',
  },
  billing_provider_invalid_response: {
    error: 'billing_provider_invalid_response',
    action: 'Retry checkout. If the problem persists, verify the Stripe Checkout provider configuration and service health.',
  },
});

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

async function assertProviderFailure(runCheckout, expectedCode = 'billing_provider_unavailable') {
  let rejectedError;
  await assert.rejects(
    runCheckout(),
    (error) => {
      rejectedError = error;
      assert.equal(error.status, 502);
      assert.equal(typeof error.getResponse, 'function');
      return true;
    },
  );

  const response = rejectedError.getResponse();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=UTF-8');
  const payload = await response.json();
  assert.deepEqual(payload, providerFailurePayloads[expectedCode]);
}

async function expectSafeProviderFailure(
  responseFactory,
  expectedCode = 'billing_provider_unavailable',
) {
  await withDefaultStripeTransport(responseFactory, async () => {
    await assertProviderFailure(
      () => createCheckout({ orgId: 91, configuration: liveConfiguration }),
      expectedCode,
    );
  });
}

function fixedSessionFactory(session) {
  return async () => ({
    checkout: {
      sessions: {
        async create() {
          return session;
        },
      },
    },
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

test('live checkout trims configuration values before the provider boundary', async () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  process.env.STRIPE_SECRET_KEY = '  sk_test_trimmed  ';
  process.env.STRIPE_PRICE_ID = '  price_trimmed  ';

  try {
    const checkout = await createCheckout({
      orgId: 94,
      configuration: liveConfiguration,
      stripeClientFactory: async (secretKey) => {
        assert.equal(secretKey, 'sk_test_trimmed');
        return {
          checkout: {
            sessions: {
              async create(payload) {
                assert.equal(payload.line_items[0].price, 'price_trimmed');
                return { url: 'https://checkout.stripe.com/c/pay/cs_test_trimmed' };
              },
            },
          },
        };
      },
    });
    assert.deepEqual(checkout, {
      url: 'https://checkout.stripe.com/c/pay/cs_test_trimmed',
      live: true,
    });
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
});

test('default live provider transport rejects network failures without leaking provider detail', async () => {
  await expectSafeProviderFailure(async () => {
    throw new Error('getaddrinfo ENOTFOUND api.stripe.com internal-network-detail');
  });
});

test('default live provider transport rejects malformed successful session payloads', async () => {
  await expectSafeProviderFailure(
    async () => new Response(JSON.stringify({
      id: 'cs_test_missing_url',
      object: 'checkout.session',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
    'billing_provider_invalid_response',
  );

  await expectSafeProviderFailure(
    async () => new Response('{not-json', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
    'billing_provider_invalid_response',
  );
});

test('live checkout rejects absent and blank provider redirect shapes', async () => {
  for (const session of [null, {}, { url: null }, { url: '' }, { url: '   ' }]) {
    await assertProviderFailure(
      () => createCheckout({
        orgId: 92,
        configuration: liveConfiguration,
        stripeClientFactory: fixedSessionFactory(session),
      }),
      'billing_provider_invalid_response',
    );
  }
});

test('live checkout rejects unsafe or malformed provider redirect URLs', async () => {
  for (const url of [
    'http://checkout.stripe.com/c/pay/cs_test_plaintext',
    'https://user@checkout.stripe.com/c/pay/cs_test_userinfo',
    'https://:password@checkout.stripe.com/c/pay/cs_test_password',
    'https://checkout.stripe.com.evil.example/c/pay/cs_test_suffix',
    'https://checkout.stripe.com:444/c/pay/cs_test_port',
    'https://attacker.example/c/pay/cs_test_foreign_host',
    'not a URL',
  ]) {
    await assertProviderFailure(
      () => createCheckout({
        orgId: 92,
        configuration: liveConfiguration,
        stripeClientFactory: fixedSessionFactory({ url }),
      }),
      'billing_provider_invalid_response',
    );
  }
});

test('live checkout maps unexpected injected provider failures to the same safe envelope', async () => {
  await assertProviderFailure(() => createCheckout({
    orgId: 93,
    configuration: liveConfiguration,
    stripeClientFactory: async () => {
      throw new Error('provider credential detail must not escape');
    },
  }));
});
