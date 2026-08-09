import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = 'scopeweave-route-test-secret-at-least-32-characters';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_route_test';

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

db.prepare("INSERT INTO users(id,email,password_hash,name) VALUES(1,'owner@example.com','x','Owner')").run();
db.prepare("INSERT INTO orgs(id,name,owner_id,plan) VALUES(42,'Route Test',1,'free')").run();
db.prepare("INSERT INTO memberships(org_id,user_id,role) VALUES(42,1,'owner')").run();

const event = JSON.stringify({
  id: 'evt_route_checkout_42',
  type: 'checkout.session.completed',
  data: {
    object: {
      client_reference_id: '42',
      metadata: { orgId: '42' },
      payment_status: 'paid',
    },
  },
});

{
  const response = await app.request('/api/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: event,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'stripe_signature_missing',
  });
  assert.equal(db.prepare('SELECT plan FROM orgs WHERE id = 42').get().plan, 'free');
}

{
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${event}`)
    .digest('hex');
  const response = await app.request('/api/stripe/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${digest}`,
    },
    body: event,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    received: true,
    duplicate: false,
  });
  assert.equal(db.prepare('SELECT plan FROM orgs WHERE id = 42').get().plan, 'pro');
}

{
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${event}`)
    .digest('hex');
  const response = await app.request('/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': `t=${timestamp},v1=${digest}` },
    body: event,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    received: true,
    duplicate: true,
  });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM billing_event_records').get().count,
    1,
  );
}
