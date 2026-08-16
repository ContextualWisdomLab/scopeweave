import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StripeSubscriptionProviderError,
  fetchStripeSubscriptionAuthoritative,
} from '../../server/stripe_subscription_provider.mjs';

const baseSubscription = Object.freeze({
  id: 'sub_authoritative123',
  object: 'subscription',
  customer: 'cus_scopeweave73',
  status: 'active',
  metadata: { orgId: '73' },
  cancel_at_period_end: false,
  current_period_start: 1_800_000_000,
  current_period_end: 1_802_592_000,
  canceled_at: null,
  ended_at: null,
  trial_end: null,
  latest_invoice: 'in_latest73',
  items: {
    data: [
      { price: { id: 'price_scopeweave_pro' } },
      { price: { id: 'price_scopeweave_addon' } },
    ],
  },
});

function jsonResponse(payload, init = {}) {
  const text = JSON.stringify(payload);
  return new Response(text, {
    status: 200,
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(text)),
      ...(init.headers || {}),
    },
  });
}

async function expectProviderError(run, expectedCode) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof StripeSubscriptionProviderError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message, expectedCode);
    assert.doesNotMatch(error.message, /sk_(?:test|live)|provider body|10\.8\.0\.7/);
    return true;
  });
}

test('authoritative subscription read performs one bounded exact Stripe GET and returns a frozen normalized snapshot', async () => {
  const observed = [];
  const signal = AbortSignal.abort('test-only');
  const snapshot = await fetchStripeSubscriptionAuthoritative({
    organizationId: 73,
    subscriptionId: 'sub_authoritative123',
    secretKey: 'sk_test_authoritative_read',
    fetchImpl: async (url, options) => {
      observed.push({ url, options });
      return jsonResponse(baseSubscription);
    },
    timeoutSignalFactory: () => signal,
  });

  assert.equal(observed.length, 1);
  assert.equal(observed[0].url, 'https://api.stripe.com/v1/subscriptions/sub_authoritative123');
  assert.equal(observed[0].options.method, 'GET');
  assert.equal(observed[0].options.redirect, 'error');
  assert.equal(observed[0].options.signal, signal);
  assert.deepEqual(observed[0].options.headers, {
    authorization: 'Bearer sk_test_authoritative_read',
    accept: 'application/json',
  });
  assert.deepEqual(snapshot, {
    subscriptionId: 'sub_authoritative123',
    customerId: 'cus_scopeweave73',
    organizationId: 73,
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodStartSec: 1_800_000_000,
    currentPeriodEndSec: 1_802_592_000,
    canceledAtSec: null,
    endedAtSec: null,
    trialEndSec: null,
    latestInvoiceId: 'in_latest73',
    priceIds: ['price_scopeweave_pro', 'price_scopeweave_addon'],
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.priceIds), true);
});

test('all current Stripe subscription statuses remain data, not local entitlement decisions', async () => {
  const statuses = [
    'incomplete',
    'incomplete_expired',
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid',
    'paused',
  ];

  for (const status of statuses) {
    const snapshot = await fetchStripeSubscriptionAuthoritative({
      organizationId: '73',
      subscriptionId: baseSubscription.id,
      secretKey: 'sk_test_statuses',
      fetchImpl: async () => jsonResponse({ ...baseSubscription, status }),
    });
    assert.equal(snapshot.status, status);
    assert.equal(snapshot.organizationId, 73);
  }
});

test('provider metadata is a routing hint only until authoritative tenant binding matches exactly', async () => {
  await expectProviderError(
    () => fetchStripeSubscriptionAuthoritative({
      organizationId: 74,
      subscriptionId: baseSubscription.id,
      secretKey: 'sk_test_tenant_mismatch',
      fetchImpl: async () => jsonResponse(baseSubscription),
    }),
    'billing_subscription_tenant_mismatch',
  );

  for (const metadata of [null, [], {}, { orgId: '' }, { orgId: '073' }, { orgId: 73 }]) {
    await expectProviderError(
      () => fetchStripeSubscriptionAuthoritative({
        organizationId: 73,
        subscriptionId: baseSubscription.id,
        secretKey: 'sk_test_tenant_shape',
        fetchImpl: async () => jsonResponse({ ...baseSubscription, metadata }),
      }),
      metadata && !Array.isArray(metadata) && metadata.orgId === 73
        ? 'billing_subscription_provider_invalid_response'
        : 'billing_subscription_tenant_mismatch',
    );
  }
});

test('malformed or contradictory provider snapshots fail closed before reconciliation can persist them', async () => {
  const invalidPayloads = [
    null,
    [],
    { ...baseSubscription, id: 'sub_other' },
    { ...baseSubscription, object: 'customer' },
    { ...baseSubscription, customer: '' },
    { ...baseSubscription, status: 'mystery' },
    { ...baseSubscription, cancel_at_period_end: 'false' },
    { ...baseSubscription, current_period_start: -1 },
    { ...baseSubscription, current_period_end: Number.MAX_SAFE_INTEGER + 1 },
    { ...baseSubscription, current_period_start: 20, current_period_end: 19 },
    { ...baseSubscription, canceled_at: 'yesterday' },
    { ...baseSubscription, latest_invoice: { id: 'in_expanded' } },
    { ...baseSubscription, items: null },
    { ...baseSubscription, items: { data: [] } },
    { ...baseSubscription, items: { data: [{ price: { id: '' } }] } },
    { ...baseSubscription, items: { data: Array.from({ length: 101 }, () => ({ price: { id: 'price_x' } })) } },
  ];

  for (const payload of invalidPayloads) {
    await expectProviderError(
      () => fetchStripeSubscriptionAuthoritative({
        organizationId: 73,
        subscriptionId: baseSubscription.id,
        secretKey: 'sk_test_invalid_snapshot',
        fetchImpl: async () => jsonResponse(payload),
      }),
      'billing_subscription_provider_invalid_response',
    );
  }
});

test('provider failures are sanitized, bodies are not parsed, and missing subscriptions stay distinct from transient failures', async () => {
  for (const [status, expectedCode] of [
    [404, 'billing_subscription_provider_not_found'],
    [429, 'billing_subscription_provider_unavailable'],
    [500, 'billing_subscription_provider_unavailable'],
  ]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('provider body sk_live_secret 10.8.0.7'));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expectProviderError(
      () => fetchStripeSubscriptionAuthoritative({
        organizationId: 73,
        subscriptionId: baseSubscription.id,
        secretKey: 'sk_test_failure',
        fetchImpl: async () => new Response(body, {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      }),
      expectedCode,
    );
    assert.equal(cancelled, true, `HTTP ${status} response body is cancelled without parsing`);
  }

  await expectProviderError(
    () => fetchStripeSubscriptionAuthoritative({
      organizationId: 73,
      subscriptionId: baseSubscription.id,
      secretKey: 'sk_test_network',
      fetchImpl: async () => {
        throw new Error('dial tcp 10.8.0.7 with sk_live_secret');
      },
    }),
    'billing_subscription_provider_unavailable',
  );
});

test('successful provider bodies require JSON and remain bounded before parsing', async () => {
  await expectProviderError(
    () => fetchStripeSubscriptionAuthoritative({
      organizationId: 73,
      subscriptionId: baseSubscription.id,
      secretKey: 'sk_test_media',
      fetchImpl: async () => new Response('<html>no</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    }),
    'billing_subscription_provider_invalid_response',
  );

  for (const declaredLength of ['not-a-number', '-1', String((256 * 1024) + 1)]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{}'));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expectProviderError(
      () => fetchStripeSubscriptionAuthoritative({
        organizationId: 73,
        subscriptionId: baseSubscription.id,
        secretKey: 'sk_test_length',
        fetchImpl: async () => new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': declaredLength,
          },
        }),
      }),
      'billing_subscription_provider_invalid_response',
    );
    assert.equal(cancelled, true);
  }

  let oversizedCancelled = false;
  let pullCount = 0;
  const oversizedBody = new ReadableStream({
    pull(controller) {
      pullCount += 1;
      controller.enqueue(new Uint8Array(pullCount === 1 ? 256 * 1024 : 1));
    },
    cancel() {
      oversizedCancelled = true;
    },
  });
  await expectProviderError(
    () => fetchStripeSubscriptionAuthoritative({
      organizationId: 73,
      subscriptionId: baseSubscription.id,
      secretKey: 'sk_test_stream_bound',
      fetchImpl: async () => new Response(oversizedBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    'billing_subscription_provider_invalid_response',
  );
  assert.equal(oversizedCancelled, true);

  await expectProviderError(
    () => fetchStripeSubscriptionAuthoritative({
      organizationId: 73,
      subscriptionId: baseSubscription.id,
      secretKey: 'sk_test_json',
      fetchImpl: async () => new Response('{invalid', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    'billing_subscription_provider_invalid_response',
  );
});

test('invalid local authority inputs fail before provider transport', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(baseSubscription);
  };

  for (const input of [
    { organizationId: 0, subscriptionId: baseSubscription.id, secretKey: 'sk_test_local' },
    { organizationId: 73, subscriptionId: '', secretKey: 'sk_test_local' },
    { organizationId: 73, subscriptionId: 'cus_wrong_type', secretKey: 'sk_test_local' },
    { organizationId: 73, subscriptionId: 'sub_bad/slash', secretKey: 'sk_test_local' },
    { organizationId: 73, subscriptionId: baseSubscription.id, secretKey: '' },
  ]) {
    await assert.rejects(
      () => fetchStripeSubscriptionAuthoritative({ ...input, fetchImpl }),
      TypeError,
    );
  }

  await assert.rejects(
    () => fetchStripeSubscriptionAuthoritative({
      organizationId: 73,
      subscriptionId: baseSubscription.id,
      secretKey: 'sk_test_local',
      fetchImpl: null,
    }),
    TypeError,
  );
  await assert.rejects(
    () => fetchStripeSubscriptionAuthoritative({
      organizationId: 73,
      subscriptionId: baseSubscription.id,
      secretKey: 'sk_test_local',
      fetchImpl,
      timeoutSignalFactory: null,
    }),
    TypeError,
  );
  assert.equal(calls, 0);
});
