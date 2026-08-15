import test from 'node:test';
import assert from 'node:assert/strict';

import { createCheckout } from '../../server/billing.mjs';

const liveConfiguration = { mode: 'live', publicOrigin: 'https://planner.example.com' };
const hostedCheckoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_boundary#fidkdWxOYHwnPyd1blpx';
const providerResponseLimitBytes = 1024 * 1024;

async function withStripeEnv(run) {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousPrice = process.env.STRIPE_PRICE_ID;
  const previousFetch = globalThis.fetch;
  process.env.STRIPE_SECRET_KEY = 'sk_test_provider_boundary';
  process.env.STRIPE_PRICE_ID = 'price_provider_boundary';
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

test('live Checkout uses one bounded direct Stripe HTTPS request and preserves the hosted URL', async () => {
  await withStripeEnv(async () => {
    const observed = [];
    globalThis.fetch = async (url, options) => {
      observed.push({ url, options });
      const payload = JSON.stringify({ url: hostedCheckoutUrl });
      return new Response(payload, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(payload)),
        },
      });
    };

    const result = await createCheckout({
      orgId: 73,
      configuration: liveConfiguration,
    });

    assert.equal(result.url, hostedCheckoutUrl, 'Stripe-hosted client fragment is preserved verbatim');
    assert.equal(observed.length, 1, 'checkout transport performs exactly one provider attempt');
    assert.equal(observed[0].url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(observed[0].options.method, 'POST');
    assert.equal(observed[0].options.redirect, 'error');
    assert.ok(observed[0].options.signal instanceof AbortSignal);
    assert.equal(observed[0].options.headers.authorization, 'Bearer sk_test_provider_boundary');
    assert.equal(observed[0].options.headers['content-type'], 'application/x-www-form-urlencoded');

    const form = new URLSearchParams(observed[0].options.body);
    assert.equal(form.get('mode'), 'subscription');
    assert.equal(form.get('line_items[0][price]'), 'price_provider_boundary');
    assert.equal(form.get('line_items[0][quantity]'), '1');
    assert.equal(form.get('success_url'), 'https://planner.example.com/?billing=success');
    assert.equal(form.get('cancel_url'), 'https://planner.example.com/?billing=cancel');
    assert.equal(form.get('client_reference_id'), '73');
    assert.equal(form.get('metadata[orgId]'), '73');
  });
});

test('live Checkout rejects malformed or untrusted provider authorities', async () => {
  const invalidUrls = [
    null,
    '',
    'not a URL',
    'http://checkout.stripe.com/c/pay/cs_test_plaintext',
    'https://user:pass@checkout.stripe.com/c/pay/cs_test_credentials',
    'https://checkout.stripe.com.evil.example/c/pay/cs_test_suffix',
    'https://checkout.stripe.com:444/c/pay/cs_test_port',
  ];

  await withStripeEnv(async () => {
    for (const url of invalidUrls) {
      globalThis.fetch = async () => new Response(JSON.stringify({ url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      await expectProviderError(
        () => createCheckout({ orgId: 73, configuration: liveConfiguration }),
        'billing_provider_invalid_response',
      );
    }
  });
});

test('provider transport failures become a stable sanitized buyer-facing error', async () => {
  await withStripeEnv(async () => {
    globalThis.fetch = async () => {
      throw new Error('dial tcp 10.7.0.12:443 with sk_live_should_not_escape');
    };

    const payload = await expectProviderError(
      () => createCheckout({ orgId: 73, configuration: liveConfiguration }),
      'billing_provider_unavailable',
    );
    assert.doesNotMatch(payload, /10\.7\.0\.12|sk_live_should_not_escape/);
  });
});

test('provider HTTP and malformed-success responses fail with stable categories', async () => {
  await withStripeEnv(async () => {
    globalThis.fetch = async () => new Response('provider secret body', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
    const unavailablePayload = await expectProviderError(
      () => createCheckout({ orgId: 73, configuration: liveConfiguration }),
      'billing_provider_unavailable',
    );
    assert.doesNotMatch(unavailablePayload, /provider secret body/);

    globalThis.fetch = async () => new Response('<html>not json</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    await expectProviderError(
      () => createCheckout({ orgId: 73, configuration: liveConfiguration }),
      'billing_provider_invalid_response',
    );

    globalThis.fetch = async () => new Response('{malformed', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await expectProviderError(
      () => createCheckout({ orgId: 73, configuration: liveConfiguration }),
      'billing_provider_invalid_response',
    );

    globalThis.fetch = async () => new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await expectProviderError(
      () => createCheckout({ orgId: 73, configuration: liveConfiguration }),
      'billing_provider_invalid_response',
    );
  });
});

test('provider response declarations and streamed bytes are bounded before JSON parsing', async () => {
  await withStripeEnv(async () => {
    for (const declaredLength of ['not-a-number', '-1', String(providerResponseLimitBytes + 1)]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ url: hostedCheckoutUrl }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': declaredLength,
        },
      });
      await expectProviderError(
        () => createCheckout({ orgId: 73, configuration: liveConfiguration }),
        'billing_provider_invalid_response',
      );
    }

    let cancelled = false;
    const oversizedBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(providerResponseLimitBytes));
        controller.enqueue(Uint8Array.of(0x20));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = async () => new Response(oversizedBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await expectProviderError(
      () => createCheckout({ orgId: 73, configuration: liveConfiguration }),
      'billing_provider_invalid_response',
    );
    assert.equal(cancelled, true, 'oversized streamed provider bodies are cancelled at the byte boundary');
  });
});

test('provider stream read failures remain sanitized invalid responses', async () => {
  await withStripeEnv(async () => {
    const failingBody = new ReadableStream({
      pull(controller) {
        controller.error(new Error('provider stream secret 10.9.0.7'));
      },
    });
    globalThis.fetch = async () => new Response(failingBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const payload = await expectProviderError(
      () => createCheckout({ orgId: 73, configuration: liveConfiguration }),
      'billing_provider_invalid_response',
    );
    assert.doesNotMatch(payload, /provider stream secret|10\.9\.0\.7/);
  });
});
