import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

process.env.SCOPEWEAVE_DB = ':memory:';
delete process.env.SCOPEWEAVE_DEV;
process.env.SCOPEWEAVE_PUBLIC_ORIGIN = 'https://scopeweave.example';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.STRIPE_SECRET_KEY = 'sk_test_scopeweave_webhook';
process.env.STRIPE_PRICE_ID = 'price_scopeweave_webhook';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_api_webhook_secret';

const { app } = await import('../../server/app.mjs?stripe-webhook-api-test=1');
const { db } = await import('../../server/db.mjs');

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const jsonHeaders = { 'content-type': 'application/json' };

function signatureHeader(body, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac('sha256', WEBHOOK_SECRET)
    .update(String(timestamp))
    .update('.')
    .update(body)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

async function signupAndOrg() {
  const signup = await app.request('https://scopeweave.example/api/auth/signup', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      email: `webhook-${Date.now()}-${Math.random()}@example.test`,
      password: 'password123',
      name: 'Webhook Owner',
    }),
  });
  assert.equal(signup.status, 200);
  const { token } = await signup.json();
  const me = await app.request('https://scopeweave.example/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.status, 200);
  const body = await me.json();
  return { token, orgId: body.orgs[0].id };
}

async function currentPlan(token) {
  const response = await app.request('https://scopeweave.example/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()).orgs[0].plan;
}

function checkoutCompletedBody(orgId) {
  return JSON.stringify({
    id: `evt_checkout_${orgId}`,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    type: 'checkout.session.completed',
    request: { id: `req_checkout_${orgId}`, idempotency_key: null },
    data: {
      object: {
        id: `cs_test_${orgId}`,
        object: 'checkout.session',
        client_reference_id: String(orgId),
        metadata: { orgId: String(orgId) },
      },
    },
  });
}

test('unsigned Stripe webhook cannot upgrade an organization', async () => {
  const { token, orgId } = await signupAndOrg();
  assert.equal(await currentPlan(token), 'free');

  const body = checkoutCompletedBody(orgId);
  const response = await app.request('https://scopeweave.example/api/stripe/webhook', {
    method: 'POST',
    headers: jsonHeaders,
    body,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'stripe_webhook_signature_invalid' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await currentPlan(token), 'free');
});

test('verified webhook is durably recorded but does not grant entitlement before reconciliation', async () => {
  const { token, orgId } = await signupAndOrg();
  const body = checkoutCompletedBody(orgId);
  const response = await app.request('https://scopeweave.example/api/stripe/webhook', {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      'stripe-signature': signatureHeader(body),
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, replayed: false });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_webhook_events').get().count, 1);
  assert.deepEqual(
    db.prepare('SELECT replay_state, processing_result FROM billing_stripe_webhook_deliveries ORDER BY delivery_id DESC LIMIT 1').get(),
    { replay_state: 'first_delivery', processing_result: 'received' },
  );
  assert.equal(
    await currentPlan(token),
    'free',
    'authenticated delivery alone cannot bypass authoritative provider-state reconciliation',
  );
});

test('exact duplicate verified event is acknowledged idempotently and retained as replay evidence', async () => {
  const { token, orgId } = await signupAndOrg();
  const body = checkoutCompletedBody(orgId);
  const headers = { ...jsonHeaders, 'stripe-signature': signatureHeader(body) };

  let response = await app.request('https://scopeweave.example/api/stripe/webhook', { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, replayed: false });

  response = await app.request('https://scopeweave.example/api/stripe/webhook', { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, replayed: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_webhook_events WHERE event_id = ?').get(`evt_checkout_${orgId}`).count, 1);
  assert.deepEqual(
    db.prepare('SELECT replay_state, processing_result FROM billing_stripe_webhook_deliveries WHERE event_id = ? ORDER BY delivery_id').all(`evt_checkout_${orgId}`),
    [
      { replay_state: 'first_delivery', processing_result: 'received' },
      { replay_state: 'duplicate_event', processing_result: 'duplicate_ignored' },
    ],
  );
  assert.equal(await currentPlan(token), 'free');
});

test('stale signed delivery and raw-body mutation fail before entitlement or ledger state changes', async () => {
  const { token, orgId } = await signupAndOrg();
  const body = checkoutCompletedBody(orgId);
  const staleTimestamp = Math.floor(Date.now() / 1000) - 301;
  const before = db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_webhook_events').get().count;

  let response = await app.request('https://scopeweave.example/api/stripe/webhook', {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      'stripe-signature': signatureHeader(body, staleTimestamp),
    },
    body,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'stripe_webhook_signature_invalid' });

  response = await app.request('https://scopeweave.example/api/stripe/webhook', {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      'stripe-signature': signatureHeader(body),
    },
    body: `${body}\n`,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'stripe_webhook_signature_invalid' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM billing_stripe_webhook_events').get().count, before);
  assert.equal(await currentPlan(token), 'free');
});
