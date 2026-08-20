import test from 'node:test';
import assert from 'node:assert/strict';

import { createCheckout } from '../../server/billing.mjs';

const liveConfiguration = { mode: 'live', publicOrigin: 'https://planner.example.com' };
const hostedCheckoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_boundary#fidkdWxOYHwnPyd1blpx';
const providerResponseLimitBytes = 1024 * 1024;

function createAttemptRepository(overrides = {}) {
  const events = [];
  return {
    events,
    startAttempt(input) {
      events.push({ type: 'start', input });
      return {
        attemptId: overrides.attemptId || 'attempt-provider-boundary',
        idempotencyKey: overrides.idempotencyKey || 'idem-provider-boundary',
        state: 'pending',
        reused: false,
      };
    },
    markProviderSucceeded(input) {
      events.push({ type: 'success', input });
    },
    markProviderFailed(input) {
      events.push({ type: 'failure', input });
      if (overrides.failureError) throw overrides.failureError;
    },
  };
}

function liveCheckout(attemptRepository, extra = {}) {
  return createCheckout({
    orgId: 73,
    configuration: liveConfiguration,
    attemptRepository,
    ...extra,
  });
}

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

function expectUnresolved(attemptRepository, message) {
  assert.deepEqual(
    attemptRepository.events.map((event) => event.type),
    ['start'],
    message,
  );
}

test('live Checkout uses one bounded direct Stripe HTTPS request and preserves the hosted URL', async () => {
  await withStripeEnv(async () => {
    const observed = [];
    const attemptRepository = createAttemptRepository();
    globalThis.fetch = async (url, options) => {
      observed.push({ url, options });
      const payload = JSON.stringify({ id: 'cs_test_boundary', url: hostedCheckoutUrl });
      return new Response(payload, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(payload)),
        },
      });
    };

    const result = await liveCheckout(attemptRepository);

    assert.equal(result.url, hostedCheckoutUrl, 'Stripe-hosted client fragment is preserved verbatim');
    assert.equal(result.checkoutAttemptId, 'attempt-provider-boundary');
    assert.equal(observed.length, 1, 'checkout transport performs exactly one provider attempt');
    assert.equal(observed[0].url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(observed[0].options.method, 'POST');
    assert.equal(observed[0].options.redirect, 'error');
    assert.ok(observed[0].options.signal instanceof AbortSignal);
    assert.equal(observed[0].options.headers.authorization, 'Bearer sk_test_provider_boundary');
    assert.equal(observed[0].options.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(observed[0].options.headers['idempotency-key'], 'idem-provider-boundary');

    const form = new URLSearchParams(observed[0].options.body);
    assert.equal(form.get('mode'), 'subscription');
    assert.equal(form.get('line_items[0][price]'), 'price_provider_boundary');
    assert.equal(form.get('line_items[0][quantity]'), '1');
    assert.equal(form.get('success_url'), 'https://planner.example.com/?billing=success');
    assert.equal(form.get('cancel_url'), 'https://planner.example.com/?billing=cancel');
    assert.equal(form.get('client_reference_id'), '73');
    assert.equal(form.get('metadata[orgId]'), '73');
    assert.deepEqual(attemptRepository.events.at(-1), {
      type: 'success',
      input: {
        attemptId: 'attempt-provider-boundary',
        providerSessionId: 'cs_test_boundary',
      },
    });
  });
});

test('live Checkout rejects malformed provider identities or untrusted browser authorities without closing retry identity', async () => {
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
      const attemptRepository = createAttemptRepository();
      globalThis.fetch = async () => new Response(JSON.stringify({ id: 'cs_test_invalid_url', url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      await expectProviderError(
        () => liveCheckout(attemptRepository),
        'billing_provider_invalid_response',
      );
      expectUnresolved(attemptRepository, 'untrusted 2xx destination remains unresolved');
    }

    for (const id of [null, '', 'x'.repeat(256)]) {
      const attemptRepository = createAttemptRepository();
      globalThis.fetch = async () => new Response(JSON.stringify({ id, url: hostedCheckoutUrl }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      await expectProviderError(
        () => liveCheckout(attemptRepository),
        'billing_provider_invalid_response',
      );
      expectUnresolved(attemptRepository, 'malformed 2xx provider identity remains unresolved');
    }
  });
});

test('uncertain transport failures stay pending and remain sanitized', async () => {
  await withStripeEnv(async () => {
    const attemptRepository = createAttemptRepository();
    globalThis.fetch = async () => {
      throw new Error('dial tcp 10.7.0.12:443 with sk_live_should_not_escape');
    };

    const payload = await expectProviderError(
      () => liveCheckout(attemptRepository),
      'billing_provider_unavailable',
    );
    assert.doesNotMatch(payload, /10\.7\.0\.12|sk_live_should_not_escape/);
    expectUnresolved(attemptRepository, 'transport failure remains unresolved');
  });
});

test('Stripe server and malformed-success outcomes remain indeterminate while 4xx closes retry identity', async () => {
  await withStripeEnv(async () => {
    let attemptRepository = createAttemptRepository();
    globalThis.fetch = async () => new Response('provider incident body', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
    const serverErrorPayload = await expectProviderError(
      () => liveCheckout(attemptRepository),
      'billing_provider_unavailable',
    );
    assert.doesNotMatch(serverErrorPayload, /provider incident body/);
    expectUnresolved(attemptRepository, '5xx is indeterminate and must preserve the same retry identity');

    attemptRepository = createAttemptRepository();
    globalThis.fetch = async () => new Response('invalid request body detail', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
    const clientErrorPayload = await expectProviderError(
      () => liveCheckout(attemptRepository),
      'billing_provider_unavailable',
    );
    assert.doesNotMatch(clientErrorPayload, /invalid request body detail/);
    assert.equal(attemptRepository.events.at(-1).type, 'failure');

    attemptRepository = createAttemptRepository();
    globalThis.fetch = async () => new Response('<html>not json</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    await expectProviderError(
      () => liveCheckout(attemptRepository),
      'billing_provider_invalid_response',
    );
    expectUnresolved(attemptRepository, 'non-JSON 2xx remains unresolved');

    attemptRepository = createAttemptRepository();
    globalThis.fetch = async () => new Response('{malformed', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await expectProviderError(
      () => liveCheckout(attemptRepository),
      'billing_provider_invalid_response',
    );
    expectUnresolved(attemptRepository, 'malformed JSON 2xx remains unresolved');

    attemptRepository = createAttemptRepository();
    globalThis.fetch = async () => new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await expectProviderError(
      () => liveCheckout(attemptRepository),
      'billing_provider_invalid_response',
    );
    expectUnresolved(attemptRepository, 'bodyless 2xx remains unresolved');
  });
});

test('rejected Stripe responses cancel unread bodies while preserving retry-state semantics', async () => {
  await withStripeEnv(async () => {
    for (const scenario of [
      { status: 503, contentType: 'application/json', expectedCode: 'billing_provider_unavailable', closesAttempt: false },
      { status: 400, contentType: 'application/json', expectedCode: 'billing_provider_unavailable', closesAttempt: true },
      { status: 200, contentType: 'text/html', expectedCode: 'billing_provider_invalid_response', closesAttempt: false },
    ]) {
      let cancelled = false;
      const unreadBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('provider bytes that must not remain leased'));
        },
        cancel() {
          cancelled = true;
        },
      });
      const attemptRepository = createAttemptRepository();
      globalThis.fetch = async () => new Response(unreadBody, {
        status: scenario.status,
        headers: { 'content-type': scenario.contentType },
      });

      await expectProviderError(
        () => liveCheckout(attemptRepository),
        scenario.expectedCode,
      );
      assert.equal(cancelled, true, `${scenario.expectedCode} cancels its unread response body`);
      if (scenario.closesAttempt) {
        assert.equal(attemptRepository.events.at(-1).type, 'failure');
      } else {
        expectUnresolved(attemptRepository, 'indeterminate provider response keeps the durable retry identity');
      }
    }
  });
});

test('response-body cleanup failure never replaces provider error or attempt outcome semantics', async () => {
  await withStripeEnv(async () => {
    let cancelCalls = 0;
    const unreadBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('provider body'));
      },
      cancel() {
        cancelCalls += 1;
        throw new Error('cleanup secret must not escape');
      },
    });
    const attemptRepository = createAttemptRepository();
    globalThis.fetch = async () => new Response(unreadBody, {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

    const payload = await expectProviderError(
      () => liveCheckout(attemptRepository),
      'billing_provider_unavailable',
    );
    assert.equal(cancelCalls, 1);
    assert.doesNotMatch(payload, /cleanup secret/);
    assert.equal(attemptRepository.events.at(-1).type, 'failure');
  });
});

test('provider response declarations and streamed bytes are bounded before JSON parsing', async () => {
  await withStripeEnv(async () => {
    for (const declaredLength of ['not-a-number', '-1', String(providerResponseLimitBytes + 1)]) {
      const attemptRepository = createAttemptRepository();
      globalThis.fetch = async () => new Response(JSON.stringify({ id: 'cs_test_bounded', url: hostedCheckoutUrl }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': declaredLength,
        },
      });
      await expectProviderError(
        () => liveCheckout(attemptRepository),
        'billing_provider_invalid_response',
      );
      expectUnresolved(attemptRepository, 'invalid successful response declaration remains unresolved');
    }

    let cancelled = false;
    let pullCount = 0;
    const oversizedBody = new ReadableStream({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new Uint8Array(providerResponseLimitBytes));
        } else {
          controller.enqueue(Uint8Array.of(0x20));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const attemptRepository = createAttemptRepository();
    globalThis.fetch = async () => new Response(oversizedBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await expectProviderError(
      () => liveCheckout(attemptRepository),
      'billing_provider_invalid_response',
    );
    assert.equal(cancelled, true, 'oversized streamed provider bodies are cancelled at the byte boundary');
    expectUnresolved(attemptRepository, 'oversized successful response remains unresolved');
  });
});

test('provider stream read failures remain sanitized invalid responses without closing retry identity', async () => {
  await withStripeEnv(async () => {
    const failingBody = new ReadableStream({
      pull(controller) {
        controller.error(new Error('provider stream secret 10.9.0.7'));
      },
    });
    const attemptRepository = createAttemptRepository();
    globalThis.fetch = async () => new Response(failingBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const payload = await expectProviderError(
      () => liveCheckout(attemptRepository),
      'billing_provider_invalid_response',
    );
    assert.doesNotMatch(payload, /provider stream secret|10\.9\.0\.7/);
    expectUnresolved(attemptRepository, 'unreadable successful response remains unresolved');
  });
});

test('a known provider failure that cannot be durably closed fails as state unavailable', async () => {
  await withStripeEnv(async () => {
    const attemptRepository = createAttemptRepository({ failureError: new Error('disk full') });
    globalThis.fetch = async () => new Response('known failure', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

    let rejected;
    await assert.rejects(
      () => liveCheckout(attemptRepository),
      (error) => {
        rejected = error;
        assert.equal(error.status, 503);
        return true;
      },
    );
    const payload = await rejected.getResponse().json();
    assert.equal(payload.error, 'billing_checkout_state_unavailable');
  });
});
