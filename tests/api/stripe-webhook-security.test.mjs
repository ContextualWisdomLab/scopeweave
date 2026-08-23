import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SCOPEWEAVE_DB = ':memory:';
delete process.env.SCOPEWEAVE_DEV;
process.env.SCOPEWEAVE_PUBLIC_ORIGIN = 'https://scopeweave.example';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.STRIPE_SECRET_KEY = 'sk_test_scopeweave_webhook';
process.env.STRIPE_PRICE_ID = 'price_scopeweave_webhook';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_api_webhook_secret';

const { app } = await import('../../server/app.mjs?stripe-webhook-security-regression=1');

const jsonHeaders = { 'content-type': 'application/json' };

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

test('unsigned Stripe provider-shaped JSON cannot upgrade an organization', async () => {
  const { token, orgId } = await signupAndOrg();
  assert.equal(await currentPlan(token), 'free');

  const response = await app.request('https://scopeweave.example/api/stripe/webhook', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      id: `evt_unsigned_${orgId}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: String(orgId),
          metadata: { orgId: String(orgId) },
        },
      },
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'stripe_webhook_signature_invalid' });
  assert.equal(await currentPlan(token), 'free');
});
