import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_PUBLIC_ORIGIN = 'http://127.0.0.1:8787';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_PRICE_ID;
delete process.env.STRIPE_WEBHOOK_SECRET;

const { app } = await import('../../server/app.mjs');

const jsonHeaders = { 'content-type': 'application/json' };

test('checkout redirects use the operator origin even when request authority differs', async () => {
  let response = await app.request('https://attacker.example/api/auth/signup', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      email: 'billing-origin@example.test',
      password: 'password123',
      name: 'Billing Origin',
    }),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  assert.ok(token);

  response = await app.request('https://attacker.example/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const me = await response.json();
  const orgId = me.orgs[0].id;
  assert.ok(orgId);

  response = await app.request(`https://attacker.example/api/orgs/${orgId}/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const checkout = await response.json();
  assert.equal(checkout.mock, true);
  assert.equal(checkout.live, false);
  assert.equal(checkout.url, `http://127.0.0.1:8787/?billing=mock&org=${orgId}`);
  assert.doesNotMatch(checkout.url, /attacker\.example/);
});
