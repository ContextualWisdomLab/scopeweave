import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
delete process.env.SCOPEWEAVE_DEV;
process.env.SCOPEWEAVE_PUBLIC_ORIGIN = 'https://planner.example.com';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.STRIPE_SECRET_KEY = 'sk_test_live_route';
process.env.STRIPE_PRICE_ID = 'price_live_route';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_live_route';

const originalFetch = globalThis.fetch;
const providerCalls = [];
let providerAttempt = 0;

globalThis.fetch = async (url, options) => {
  providerAttempt += 1;
  providerCalls.push({ url, options });
  if (providerAttempt === 1) {
    throw new Error('simulated connection loss after request dispatch');
  }
  return new Response(JSON.stringify({
    id: 'cs_test_live_route_recovered',
    url: 'https://checkout.stripe.com/c/pay/cs_test_live_route_recovered',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

const jsonHeaders = { 'content-type': 'application/json' };

async function createOwner() {
  const signup = await app.request('https://edge.example/api/auth/signup', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      email: 'billing-live-route@example.test',
      password: 'password123',
      name: 'Billing Live Route',
    }),
  });
  assert.equal(signup.status, 200);
  const { token } = await signup.json();
  assert.ok(token);

  const me = await app.request('https://edge.example/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.status, 200);
  const profile = await me.json();
  assert.equal(profile.orgs.length, 1);
  return { token, orgId: profile.orgs[0].id };
}

test('uncertain live Checkout retries reuse one persisted provider identity end to end', async () => {
  try {
    const { token, orgId } = await createOwner();
    const requestOptions = {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    };

    const first = await app.request(
      `https://untrusted-proxy.example/api/orgs/${orgId}/checkout`,
      requestOptions,
    );
    assert.equal(first.status, 502);
    assert.deepEqual(await first.json(), {
      error: 'billing_provider_unavailable',
      action: 'Retry checkout. If the problem persists, verify Stripe connectivity and service health before retrying.',
    });

    const pendingRows = db.prepare(`
      SELECT attempt_id, organization_id, price_id, idempotency_key, attempt_state,
             provider_session_id
      FROM billing_checkout_attempts
      WHERE organization_id = ?
    `).all(orgId);
    assert.equal(pendingRows.length, 1);
    assert.equal(pendingRows[0].attempt_state, 'pending');
    assert.equal(pendingRows[0].provider_session_id, null);

    const second = await app.request(
      `https://different-proxy.example/api/orgs/${orgId}/checkout`,
      requestOptions,
    );
    assert.equal(second.status, 200);
    const recovered = await second.json();
    assert.equal(recovered.live, true);
    assert.equal(
      recovered.url,
      'https://checkout.stripe.com/c/pay/cs_test_live_route_recovered',
    );
    assert.equal(recovered.checkoutAttemptId, pendingRows[0].attempt_id);

    assert.equal(providerCalls.length, 2);
    assert.equal(providerCalls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(providerCalls[1].url, providerCalls[0].url);
    assert.equal(
      providerCalls[1].options.headers['idempotency-key'],
      providerCalls[0].options.headers['idempotency-key'],
      'the retry must reuse the first uncertain attempt idempotency key',
    );
    assert.equal(
      providerCalls[0].options.headers['idempotency-key'],
      pendingRows[0].idempotency_key,
    );

    for (const call of providerCalls) {
      const form = new URLSearchParams(call.options.body);
      assert.equal(form.get('success_url'), 'https://planner.example.com/?billing=success');
      assert.equal(form.get('cancel_url'), 'https://planner.example.com/?billing=cancel');
      assert.equal(form.get('line_items[0][price]'), 'price_live_route');
      assert.equal(form.get('client_reference_id'), String(orgId));
      assert.equal(form.get('metadata[orgId]'), String(orgId));
    }

    const settledRows = db.prepare(`
      SELECT attempt_id, attempt_state, provider_session_id
      FROM billing_checkout_attempts
      WHERE organization_id = ?
    `).all(orgId);
    assert.deepEqual(settledRows.map((row) => ({ ...row })), [{
      attempt_id: pendingRows[0].attempt_id,
      attempt_state: 'provider_succeeded',
      provider_session_id: 'cs_test_live_route_recovered',
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
