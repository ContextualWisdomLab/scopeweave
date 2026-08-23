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

const { app } = await import('../../server/app.mjs?stripe-webhook-api-hotfix-test=1');

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
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_test_${orgId}`,
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

test('verified webhook is acknowledged but does not grant entitlement before durable reconciliation', async () => {
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
  assert.deepEqual(await response.json(), { received: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    await currentPlan(token),
    'free',
    'authenticated delivery alone cannot bypass durable duplicate/order/provider-state reconciliation',
  );
});

test('stale signed delivery and raw-body mutation fail before entitlement state changes', async () => {
  const { token, orgId } = await signupAndOrg();
  const body = checkoutCompletedBody(orgId);
  const staleTimestamp = Math.floor(Date.now() / 1000) - 301;

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
  assert.equal(await currentPlan(token), 'free');
});
