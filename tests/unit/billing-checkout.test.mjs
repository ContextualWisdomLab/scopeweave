import test from 'node:test';
import assert from 'node:assert/strict';

import { createCheckout } from '../../server/billing.mjs';

const disabledConfiguration = { mode: 'disabled', publicOrigin: null };
const mockConfiguration = { mode: 'mock', publicOrigin: 'http://127.0.0.1:8787' };
const liveConfiguration = { mode: 'live', publicOrigin: 'https://planner.example.com' };

function createAttemptRepository(overrides = {}) {
  const events = [];
  return {
    events,
    startAttempt(input) {
      events.push({ type: 'start', input });
      if (overrides.startError) throw overrides.startError;
      return {
        attemptId: overrides.attemptId || 'attempt-test-001',
        idempotencyKey: overrides.idempotencyKey || 'idem-test-001',
        state: 'pending',
        reused: false,
      };
    },
    markProviderSucceeded(input) {
      events.push({ type: 'success', input });
      if (overrides.successError) throw overrides.successError;
    },
    markProviderFailed(input) {
      events.push({ type: 'failure', input });
      if (overrides.failureError) throw overrides.failureError;
    },
  };
}

async function responsePayloadFrom(error) {
  assert.equal(typeof error.getResponse, 'function');
  return error.getResponse().json();
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

test('live checkout binds SDK-style calls to the durable idempotency identity', async () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  process.env.STRIPE_SECRET_KEY = 'sk_test_trusted';
  process.env.STRIPE_PRICE_ID = 'price_trusted';

  const calls = [];
  const attemptRepository = createAttemptRepository();
  const fakeStripeClientFactory = async (secretKey) => {
    assert.equal(secretKey, 'sk_test_trusted');
    return {
      checkout: {
        sessions: {
          async create(payload, requestOptions) {
            calls.push({ payload, requestOptions });
            return {
              id: 'cs_test_123',
              url: 'https://checkout.stripe.com/c/pay/cs_test_123',
            };
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
      attemptRepository,
      stripeClientFactory: fakeStripeClientFactory,
    });

    assert.deepEqual(checkout, {
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      live: true,
      checkoutAttemptId: 'attempt-test-001',
    });
    assert.deepEqual(calls, [{
      payload: {
        mode: 'subscription',
        line_items: [{ price: 'price_trusted', quantity: 1 }],
        success_url: 'https://planner.example.com/?billing=success',
        cancel_url: 'https://planner.example.com/?billing=cancel',
        client_reference_id: '73',
        metadata: { orgId: '73' },
        subscription_data: { metadata: { orgId: '73' } },
      },
      requestOptions: { idempotencyKey: 'idem-test-001' },
    }]);
    assert.deepEqual(attemptRepository.events, [
      { type: 'start', input: { organizationId: 73, priceId: 'price_trusted' } },
      {
        type: 'success',
        input: { attemptId: 'attempt-test-001', providerSessionId: 'cs_test_123' },
      },
    ]);
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
});

test('default live provider transport sends the persisted Stripe Idempotency-Key', async () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  const previousFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = 'sk_test_default_transport';
  process.env.STRIPE_PRICE_ID = 'price_default_transport';

  const calls = [];
  const attemptRepository = createAttemptRepository({
    attemptId: 'attempt-default-transport',
    idempotencyKey: 'idem-default-transport',
  });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      id: 'cs_test_default_transport',
      url: 'https://checkout.stripe.com/c/pay/cs_test_default_transport',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };

  try {
    const checkout = await createCheckout({
      orgId: 91,
      origin: 'https://attacker.example',
      configuration: liveConfiguration,
      attemptRepository,
    });

    assert.deepEqual(checkout, {
      url: 'https://checkout.stripe.com/c/pay/cs_test_default_transport',
      live: true,
      checkoutAttemptId: 'attempt-default-transport',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.redirect, 'error');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.headers.authorization, 'Bearer sk_test_default_transport');
    assert.equal(calls[0].options.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(calls[0].options.headers['idempotency-key'], 'idem-default-transport');

    const form = new URLSearchParams(calls[0].options.body);
    assert.equal(form.get('mode'), 'subscription');
    assert.equal(form.get('line_items[0][price]'), 'price_default_transport');
    assert.equal(form.get('line_items[0][quantity]'), '1');
    assert.equal(form.get('success_url'), 'https://planner.example.com/?billing=success');
    assert.equal(form.get('cancel_url'), 'https://planner.example.com/?billing=cancel');
    assert.equal(form.get('client_reference_id'), '91');
    assert.equal(form.get('metadata[orgId]'), '91');
    assert.equal(form.get('subscription_data[metadata][orgId]'), '91');
    assert.deepEqual(attemptRepository.events.at(-1), {
      type: 'success',
      input: {
        attemptId: 'attempt-default-transport',
        providerSessionId: 'cs_test_default_transport',
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
});

test('live checkout fails closed when the durable attempt port cannot start or commit success', async () => {
  const previousPrice = process.env.STRIPE_PRICE_ID;
  process.env.STRIPE_PRICE_ID = 'price_state_failure';

  try {
    for (const attemptRepository of [
      {},
      createAttemptRepository({ startError: new Error('database unavailable') }),
    ]) {
      let rejected;
      await assert.rejects(
        createCheckout({ orgId: 73, configuration: liveConfiguration, attemptRepository }),
        (error) => {
          rejected = error;
          assert.equal(error.status, 503);
          return true;
        },
      );
      assert.equal((await responsePayloadFrom(rejected)).error, 'billing_checkout_state_unavailable');
    }

    const attemptRepository = createAttemptRepository({ successError: new Error('commit failed') });
    const stripeClientFactory = async () => ({
      checkout: {
        sessions: {
          async create() {
            return { id: 'cs_test_state_failure', url: 'https://checkout.stripe.com/c/pay/cs_test_state_failure' };
          },
        },
      },
    });
    let rejected;
    await assert.rejects(
      createCheckout({
        orgId: 73,
        configuration: liveConfiguration,
        attemptRepository,
        stripeClientFactory,
      }),
      (error) => {
        rejected = error;
        assert.equal(error.status, 503);
        return true;
      },
    );
    assert.equal((await responsePayloadFrom(rejected)).error, 'billing_checkout_state_unavailable');
  } finally {
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
});

test('stale uncertain Checkout state tells the customer not to mint a speculative retry', async () => {
  const previousPrice = process.env.STRIPE_PRICE_ID;
  process.env.STRIPE_PRICE_ID = 'price_reconciliation_required';
  const reconciliationError = new Error('provider outcome must be reconciled');
  reconciliationError.code = 'billing_checkout_reconciliation_required';
  const attemptRepository = createAttemptRepository({ startError: reconciliationError });

  try {
    let rejected;
    await assert.rejects(
      createCheckout({ orgId: 73, configuration: liveConfiguration, attemptRepository }),
      (error) => {
        rejected = error;
        assert.equal(error.status, 503);
        return true;
      },
    );
    const payload = await responsePayloadFrom(rejected);
    assert.equal(payload.error, 'billing_checkout_reconciliation_required');
    assert.match(payload.action, /reconcil/i);
    assert.match(payload.action, /do not start|do not retry|before/i);
    assert.deepEqual(attemptRepository.events.map((event) => event.type), ['start']);
  } finally {
    if (previousPrice === undefined) delete process.env.STRIPE_PRICE_ID;
    else process.env.STRIPE_PRICE_ID = previousPrice;
  }
});