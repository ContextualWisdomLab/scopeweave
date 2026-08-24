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

const { app } = await import('../../server/app.mjs?stripe-webhook-security-regression=1');
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
      email: `stripe-security-${Date.now()}-${Math.random()}@example.test`,
      password: 'password123',
      name: 'Stripe Security Owner',
    }),
  });
  assert.equal(signup.status, 200);
  const { token } = await signup.json();
  const me = await app.request('https://scopeweave.example/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.status, 200);
  return { token, orgId: (await me.json()).orgs[0].id };
}

async function currentPlan(token) {
  const response = await app.request('https://scopeweave.example/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()).orgs[0].plan;
}

function checkoutCompletedBody(orgId, idPrefix = 'evt_checkout', paymentStatus = 'paid') {
  return JSON.stringify({
    id: `${idPrefix}_${orgId}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'subscription',
        payment_status: paymentStatus,
        client_reference_id: String(orgId),
        metadata: { orgId: String(orgId) },
      },
    },
  });
}

test('unsigned Stripe provider-shaped JSON cannot upgrade an organization', async () => {
  const { token, orgId } = await signupAndOrg();
  assert.equal(await currentPlan(token), 'free');

  const response = await app.request('https://scopeweave.example/api/stripe/webhook', {
    method: 'POST',
    headers: jsonHeaders,
    body: checkoutCompletedBody(orgId, 'evt_unsigned'),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'stripe_webhook_signature_invalid' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await currentPlan(token), 'free');
});

test('verified paid subscription checkout activates the matching organization idempotently', async () => {
  const { token, orgId } = await signupAndOrg();
  const body = checkoutCompletedBody(orgId);
  const send = () => app.request('https://scopeweave.example/api/stripe/webhook', {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      'stripe-signature': signatureHeader(body),
    },
    body,
  });

  let response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    await currentPlan(token),
    'pro',
    'a verified paid checkout created for this organization must activate the purchased plan',
  );

  response = await send();
  assert.equal(response.status, 200, 'provider retries are acknowledged');
  assert.equal(await currentPlan(token), 'pro');
  const audit = db.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_log
    WHERE org_id = ?
      AND action = 'billing.checkout_completed'
      AND target_type = 'stripe_event'
      AND target_id = ?
  `).get(orgId, `evt_checkout_${orgId}`);
  assert.equal(audit.count, 1, 'the same verified Stripe event is reconciled exactly once');
});

test('verified unpaid checkout is acknowledged without granting entitlement', async () => {
  const { token, orgId } = await signupAndOrg();
  const body = checkoutCompletedBody(orgId, 'evt_unpaid', 'unpaid');
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
  assert.equal(await currentPlan(token), 'free');
  const audit = db.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_log
    WHERE action = 'billing.checkout_completed'
      AND target_type = 'stripe_event'
      AND target_id = ?
  `).get(`evt_unpaid_${orgId}`);
  assert.equal(audit.count, 0, 'an unpaid checkout cannot enter the entitlement ledger');
});

test('stale signatures and raw-body mutation fail closed without changing plan state', async () => {
  const { token, orgId } = await signupAndOrg();
  const body = checkoutCompletedBody(orgId, 'evt_replay');
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
