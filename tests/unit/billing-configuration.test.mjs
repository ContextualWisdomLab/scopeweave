import assert from 'node:assert/strict';
import { BillingConfigurationError, createCheckout } from '../../server/billing.mjs';

const ORIGINAL_ENV = { ...process.env };

function restoreEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

try {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_ID;
  delete process.env.SCOPEWEAVE_DEV;

  await assert.rejects(
    createCheckout({ orgId: 42, origin: 'https://scopeweave.example' }),
    (error) => error instanceof BillingConfigurationError
      && error.code === 'billing_not_configured',
    'production checkout must fail closed instead of returning a mock URL',
  );

  process.env.SCOPEWEAVE_DEV = '1';
  const development = await createCheckout({
    orgId: 42,
    origin: 'http://localhost:3000',
  });
  assert.deepEqual(development, {
    url: 'http://localhost:3000/?billing=mock&org=42',
    live: false,
    mock: true,
  });

  process.env.STRIPE_SECRET_KEY = 'sk_test_partial';
  delete process.env.STRIPE_PRICE_ID;
  await assert.rejects(
    createCheckout({ orgId: 42, origin: 'http://localhost:3000' }),
    (error) => error instanceof BillingConfigurationError
      && error.code === 'billing_configuration_incomplete',
    'partial Stripe configuration must fail before contacting the provider',
  );

  process.env.STRIPE_PRICE_ID = 'price_pro';
  const calls = [];
  const production = await createCheckout({
    orgId: 42,
    origin: 'https://scopeweave.example',
    idempotencyKey: 'checkout-attempt-42',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.deepEqual(production, {
    url: 'https://checkout.stripe.com/c/pay/cs_test',
    live: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk_test_partial');
  assert.equal(calls[0].init.headers['idempotency-key'], 'checkout-attempt-42');
  assert.equal(calls[0].init.headers['stripe-version'], '2026-02-25.clover');
  const posted = new URLSearchParams(calls[0].init.body);
  assert.equal(posted.get('mode'), 'subscription');
  assert.equal(posted.get('line_items[0][price]'), 'price_pro');
  assert.equal(posted.get('client_reference_id'), '42');
  assert.equal(posted.get('metadata[orgId]'), '42');
  assert.equal(posted.get('subscription_data[metadata][orgId]'), '42');

  await assert.rejects(
    createCheckout({
      orgId: 42,
      origin: 'https://scopeweave.example',
      fetchImpl: null,
    }),
    (error) => error instanceof BillingConfigurationError
      && error.code === 'billing_transport_unavailable',
  );

  await assert.rejects(
    createCheckout({
      orgId: 42,
      origin: 'https://scopeweave.example',
      fetchImpl: async () => { throw new Error('offline'); },
    }),
    (error) => error instanceof BillingConfigurationError
      && error.code === 'billing_provider_unavailable',
  );

  await assert.rejects(
    createCheckout({
      orgId: 42,
      origin: 'https://scopeweave.example',
      fetchImpl: async () => new Response('{"error":{}}', {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    (error) => error instanceof BillingConfigurationError
      && error.code === 'billing_provider_rejected',
  );

  await assert.rejects(
    createCheckout({
      orgId: 42,
      origin: 'https://scopeweave.example',
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    }),
    (error) => error instanceof BillingConfigurationError
      && error.code === 'billing_provider_invalid_response',
  );

  await assert.rejects(
    createCheckout({
      orgId: 42,
      origin: 'https://scopeweave.example',
      fetchImpl: async () => new Response('[]', { status: 200 }),
    }),
    (error) => error instanceof BillingConfigurationError
      && error.code === 'billing_provider_invalid_response',
  );

  await assert.rejects(
    createCheckout({
      orgId: 42,
      origin: 'https://scopeweave.example',
      fetchImpl: async () => new Response('{"url":"https://attacker.example/checkout"}', { status: 200 }),
    }),
    (error) => error instanceof BillingConfigurationError
      && error.code === 'billing_provider_invalid_response',
  );
} finally {
  restoreEnvironment();
}
