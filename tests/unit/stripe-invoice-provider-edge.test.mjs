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

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function expectProviderCode(code) {
  return (error) => {
    assert.ok(error instanceof StripeInvoiceProviderError);
    assert.equal(error.code, code);
    return true;
  };
}

test('edge contracts cover malformed provider envelopes, stream failures, and compatibility branches', async () => {
  const invalid = expectProviderCode('billing_invoice_provider_invalid_response');
  const malformedPayloads = [
    null,
    [],
    { ...currentInvoice(), id: 'in_other' },
    { ...currentInvoice(), object: 'charge' },
    { ...currentInvoice(), customer: null },
    { ...currentInvoice(), parent: [] },
    { ...currentInvoice(), parent: { type: 'subscription_details', subscription_details: null } },
    { ...currentInvoice(), parent: { type: 'subscription_details', subscription_details: { subscription: null, metadata: {} } } },
    { ...currentInvoice(), parent: undefined, subscription: undefined, subscription_details: undefined },
    { ...currentInvoice(), parent: undefined, subscription: EXPECTED.subscriptionId, subscription_details: [] },
    { ...currentInvoice(), parent: undefined, subscription: EXPECTED.subscriptionId, subscription_details: { metadata: 'bad' } },
    { ...currentInvoice(), parent: undefined, subscription: EXPECTED.subscriptionId, subscription_details: { metadata: { orgId: 42 } } },
    { ...currentInvoice(), status_transitions: null },
    { ...currentInvoice(), status_transitions: [] },
    { ...currentInvoice(), paid: 'yes' },
  ];
  for (const payload of malformedPayloads) {
    await assert.rejects(fetchStripeInvoiceAuthoritative({ ...EXPECTED, fetchImpl: async () => jsonResponse(payload) }), invalid);
  }

  const dualShape = currentInvoice({
    parent: { type: 'subscription_details', subscription_details: { subscription: EXPECTED.subscriptionId, metadata: null } },
    subscription: EXPECTED.subscriptionId,
  });
  const dualSnapshot = await fetchStripeInvoiceAuthoritative({ ...EXPECTED, fetchImpl: async () => jsonResponse(dualShape) });
  assert.equal(dualSnapshot.subscriptionId, EXPECTED.subscriptionId);

  const openInvoice = currentInvoice({ status: 'open', paid: false, status_transitions: { paid_at: null }, amount_paid: 0, amount_remaining: 29000 });
  const openSnapshot = await fetchStripeInvoiceAuthoritative({ ...EXPECTED, fetchImpl: async () => jsonResponse(openInvoice) });
  assert.equal(openSnapshot.status, 'open');
  assert.equal(openSnapshot.paidAtSec, null);

  const encoded = JSON.stringify(currentInvoice());
  const encodedBytes = new TextEncoder().encode(encoded);
  const declared = await fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => new Response(encodedBytes, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(encodedBytes.byteLength) },
    }),
  });
  assert.equal(declared.invoiceId, EXPECTED.invoiceId);

  for (const contentLength of ['nope', '-1']) {
    await assert.rejects(fetchStripeInvoiceAuthoritative({
      ...EXPECTED,
      fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': contentLength } }),
    }), invalid);
  }

  await assert.rejects(fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => new Response(null, { headers: { 'content-type': 'application/json' } }),
  }), invalid);
  await assert.rejects(fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => new Response('{', { headers: { 'content-type': 'application/json' } }),
  }), invalid);

  const readFailureStream = new ReadableStream({ pull(controller) { controller.error(new Error('read failure')); } });
  await assert.rejects(fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => new Response(readFailureStream, { headers: { 'content-type': 'application/json' } }),
  }), invalid);

  const oversizedStream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
    cancel() { throw new Error('cancel failure'); },
  });
  await assert.rejects(fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => new Response(oversizedStream, { headers: { 'content-type': 'application/json' } }),
  }), invalid);

  let oversizedRead = false;
  const rejectingCancelResponse = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {
      getReader() {
        return {
          async read() {
            if (oversizedRead) return { done: true, value: undefined };
            oversizedRead = true;
            return { done: false, value: new Uint8Array(256 * 1024 + 1) };
          },
          async cancel() { throw new Error('reader cancel failure'); },
        };
      },
    },
  };
  await assert.rejects(fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => rejectingCancelResponse,
  }), invalid);

  const cancelFailureStream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('not json')); },
    cancel() { throw new Error('cancel failure'); },
  });
  await assert.rejects(fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => new Response(cancelFailureStream, { headers: { 'content-type': 'text/plain' } }),
  }), invalid);

  await assert.rejects(fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => new Response(null, { status: 500 }),
  }), expectProviderCode('billing_invoice_provider_unavailable'));
  await assert.rejects(fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => ({ ok: true, headers: null }),
  }), invalid);
  await assert.rejects(fetchStripeInvoiceAuthoritative({
    ...EXPECTED,
    fetchImpl: async () => new Response('{}', { headers: {} }),
  }), invalid);
  await assert.rejects(fetchStripeInvoiceAuthoritative({ ...EXPECTED, fetchImpl: async () => jsonResponse({ ...currentInvoice(), amount_due: null }) }), invalid);
  await assert.rejects(fetchStripeInvoiceAuthoritative({ ...EXPECTED, timeoutSignalFactory: null }), TypeError);
});
