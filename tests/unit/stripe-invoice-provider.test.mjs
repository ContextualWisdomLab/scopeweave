import assert from 'node:assert/strict';
import test from 'node:test';

import {
  StripeInvoiceProviderError,
  fetchStripeInvoiceAuthoritative,
} from '../../server/stripe_invoice_provider.mjs';

const EXPECTED = Object.freeze({
  organizationId: 42,
  invoiceId: 'in_invoice_42',
  subscriptionId: 'sub_scopeweave_42',
  customerId: 'cus_scopeweave_42',
  secretKey: 'sk_test_scopeweave_invoice_reader',
});

function currentInvoice(overrides = {}) {
  return {
    id: EXPECTED.invoiceId,
    object: 'invoice',
    customer: EXPECTED.customerId,
    status: 'paid',
    paid: true,
    currency: 'krw',
    amount_due: 29000,
    amount_paid: 29000,
    amount_remaining: 0,
    created: 1_786_000_000,
    status_transitions: { paid_at: 1_786_000_100 },
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: EXPECTED.subscriptionId,
        metadata: { orgId: String(EXPECTED.organizationId) },
      },
    },
    ...overrides,
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
}

function expectProviderCode(code) {
  return (error) => {
    assert.ok(error instanceof StripeInvoiceProviderError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

test('authoritative invoice read uses one exact bounded Stripe GET and returns an immutable current-shape snapshot', async () => {
  const calls = [];
  const snapshot = await fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    timeoutSignalFactory: () => AbortSignal.timeout(1_000),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(currentInvoice());
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.stripe.com/v1/invoices/${EXPECTED.invoiceId}`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${EXPECTED.secretKey}`);
  assert.equal(calls[0].init.headers.accept, 'application/json');
  assert.equal(Object.hasOwn(calls[0].init.headers, 'Stripe-Version'), false);
  assert.deepEqual(snapshot, {
    invoiceId: EXPECTED.invoiceId,
    subscriptionId: EXPECTED.subscriptionId,
    customerId: EXPECTED.customerId,
    organizationId: EXPECTED.organizationId,
    status: 'paid',
    paid: true,
    currency: 'krw',
    amountDue: 29000,
    amountPaid: 29000,
    amountRemaining: 0,
    createdSec: 1_786_000_000,
    paidAtSec: 1_786_000_100,
  });
  assert.ok(Object.isFrozen(snapshot));
});

test('reader accepts the legacy pre-Basil subscription shape without weakening exact identity checks', async () => {
  const legacy = currentInvoice({
    parent: undefined,
    subscription: EXPECTED.subscriptionId,
    subscription_details: { metadata: { orgId: String(EXPECTED.organizationId) } },
  });
  const snapshot = await fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => jsonResponse(legacy),
  });
  assert.equal(snapshot.subscriptionId, EXPECTED.subscriptionId);

  await assert.rejects(
    fetchStripeInvoiceAuthoritative({
      ...EXPECTED,
      fetchImpl: async () => jsonResponse(currentInvoice({
        subscription: 'sub_conflicting_legacy',
      })),
    }),
    expectProviderCode('billing_invoice_provider_invalid_response'),
  );
});

test('customer, subscription, and available tenant metadata must match server-owned authority exactly', async () => {
  for (const payload of [
    currentInvoice({ customer: 'cus_other_tenant' }),
    currentInvoice({ parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_other_tenant',
        metadata: { orgId: String(EXPECTED.organizationId) },
      },
    } }),
    currentInvoice({ parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: EXPECTED.subscriptionId,
        metadata: { orgId: '9001' },
      },
    } }),
  ]) {
    await assert.rejects(
      fetchStripeInvoiceAuthoritative({ ...EXPECTED, fetchImpl: async () => jsonResponse(payload) }),
      expectProviderCode('billing_invoice_tenant_mismatch'),
    );
  }

  const withoutMetadata = currentInvoice({ parent: {
    type: 'subscription_details',
    subscription_details: { subscription: EXPECTED.subscriptionId, metadata: {} },
  } });
  const accepted = await fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => jsonResponse(withoutMetadata),
  });
  assert.equal(accepted.organizationId, EXPECTED.organizationId);
});

test('invoice lifecycle and arithmetic contradictions fail closed before policy evidence is returned', async () => {
  const invalidPayloads = [
    currentInvoice({ status: 'paid', paid: false }),
    currentInvoice({ status: 'open', paid: true, status_transitions: { paid_at: null } }),
    currentInvoice({ status: 'paid', status_transitions: { paid_at: null } }),
    currentInvoice({ status: 'open', paid: false, status_transitions: { paid_at: 1_786_000_100 } }),
    currentInvoice({ status: 'mystery' }),
    currentInvoice({ currency: 'KRW' }),
    currentInvoice({ amount_due: -1 }),
    currentInvoice({ amount_paid: Number.MAX_SAFE_INTEGER + 1 }),
    currentInvoice({ amount_remaining: -1 }),
    currentInvoice({ created: -1 }),
    currentInvoice({ parent: { type: 'quote_details', quote_details: { quote: 'qt_1' } } }),
  ];

  for (const payload of invalidPayloads) {
    await assert.rejects(
      fetchStripeInvoiceAuthoritative({ ...EXPECTED, fetchImpl: async () => jsonResponse(payload) }),
      expectProviderCode('billing_invoice_provider_invalid_response'),
    );
  }
});

test('provider failures, media type, and response bytes are bounded and sanitized', async () => {
  await assert.rejects(
    fetchStripeInvoiceAuthoritative({
      ...EXPECTED,
      fetchImpl: async () => { throw new Error('socket includes secret'); },
    }),
    expectProviderCode('billing_invoice_provider_unavailable'),
  );

  await assert.rejects(
    fetchStripeInvoiceAuthoritative({
      ...EXPECTED,
      fetchImpl: async () => new Response('missing', { status: 404 }),
    }),
    expectProviderCode('billing_invoice_provider_not_found'),
  );

  await assert.rejects(
    fetchStripeInvoiceAuthoritative({
      ...EXPECTED,
      fetchImpl: async () => new Response('provider secret body', { status: 503 }),
    }),
    expectProviderCode('billing_invoice_provider_unavailable'),
  );

  await assert.rejects(
    fetchStripeInvoiceAuthoritative({
      ...EXPECTED,
      fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } }),
    }),
    expectProviderCode('billing_invoice_provider_invalid_response'),
  );

  await assert.rejects(
    fetchStripeInvoiceAuthoritative({
      ...EXPECTED,
      fetchImpl: async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(256 * 1024 + 1) },
      }),
    }),
    expectProviderCode('billing_invoice_provider_invalid_response'),
  );
});

test('malformed local invoice authority and dependency seams fail before provider transport', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(currentInvoice());
  };
  const invalidInputs = [
    { organizationId: 0 },
    { organizationId: '42' },
    { invoiceId: 'pi_wrong_kind' },
    { subscriptionId: 'in_wrong_kind' },
    { customerId: '' },
    { secretKey: '' },
  ];

  for (const patch of invalidInputs) {
    await assert.rejects(fetchStripeInvoiceAuthoritative({ ...EXPECTED, fetchImpl, ...patch }), TypeError);
  }
  assert.equal(calls, 0);

  await assert.rejects(
    fetchStripeInvoiceAuthoritative({ ...EXPECTED, fetchImpl: null }),
    TypeError,
  );
  await assert.rejects(
    fetchStripeInvoiceAuthoritative({ ...EXPECTED, fetchImpl, timeoutSignalFactory: () => ({}) }),
    TypeError,
  );
  await assert.rejects(
    fetchStripeInvoiceAuthoritative({
      ...EXPECTED,
      fetchImpl,
      timeoutSignalFactory: () => { throw new Error('clock failure'); },
    }),
    expectProviderCode('billing_invoice_provider_unavailable'),
  );
});
