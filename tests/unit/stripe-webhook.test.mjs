import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  StripeWebhookError,
  processStripeWebhook,
  verifyStripeSignature,
} from '../../server/stripe-webhook.mjs';

const WEBHOOK_SECRET = 'whsec_scopeweave_test_secret';
const NOW_SECONDS = 1_786_291_200;

function signatureFor(payload, timestamp = NOW_SECONDS, secret = WEBHOOK_SECRET) {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE orgs (
      id INTEGER PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free'
    );
    INSERT INTO orgs(id, plan) VALUES (42, 'free');
  `);
  return db;
}

function eventPayload(overrides = {}) {
  return JSON.stringify({
    id: 'evt_checkout_42',
    type: 'checkout.session.completed',
    data: {
      object: {
        client_reference_id: '42',
        metadata: { orgId: '42' },
        payment_status: 'paid',
      },
    },
    ...overrides,
  });
}

{
  const payload = eventPayload();
  const verified = verifyStripeSignature({
    rawBody: Buffer.from(payload),
    signatureHeader: signatureFor(payload),
    webhookSecret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });
  assert.equal(verified.timestamp, NOW_SECONDS);
}

for (const [name, mutate] of [
  ['missing signature', () => ({ signatureHeader: '' })],
  ['altered body', (payload) => ({ rawBody: Buffer.from(`${payload} `) })],
  ['wrong secret', () => ({ webhookSecret: 'whsec_wrong' })],
  ['stale timestamp', (payload) => ({ signatureHeader: signatureFor(payload, NOW_SECONDS - 301) })],
]) {
  const payload = eventPayload();
  assert.throws(
    () => verifyStripeSignature({
      rawBody: Buffer.from(payload),
      signatureHeader: signatureFor(payload),
      webhookSecret: WEBHOOK_SECRET,
      nowSeconds: NOW_SECONDS,
      ...mutate(payload),
    }),
    (error) => error instanceof StripeWebhookError,
    name,
  );
}

{
  const db = database();
  const payload = eventPayload();
  const result = processStripeWebhook({
    db,
    rawBody: Buffer.from(payload),
    signatureHeader: signatureFor(payload),
    webhookSecret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });
  assert.deepEqual(result, {
    received: true,
    duplicate: false,
    organizationId: 42,
    plan: 'pro',
    eventType: 'checkout.session.completed',
  });
  assert.equal(db.prepare('SELECT plan FROM orgs WHERE id = 42').get().plan, 'pro');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM billing_event_records').get().count,
    1,
  );

  const duplicate = processStripeWebhook({
    db,
    rawBody: Buffer.from(payload),
    signatureHeader: signatureFor(payload),
    webhookSecret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });
  assert.deepEqual(duplicate, {
    received: true,
    duplicate: true,
    organizationId: 42,
    plan: 'pro',
    eventType: 'checkout.session.completed',
  });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM billing_event_records').get().count,
    1,
  );
}

{
  const db = database();
  db.prepare("UPDATE orgs SET plan = 'pro' WHERE id = 42").run();
  const payload = eventPayload({
    id: 'evt_subscription_deleted_42',
    type: 'customer.subscription.deleted',
    data: { object: { metadata: { orgId: '42' }, status: 'canceled' } },
  });
  const result = processStripeWebhook({
    db,
    rawBody: Buffer.from(payload),
    signatureHeader: signatureFor(payload),
    webhookSecret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });
  assert.equal(result.plan, 'free');
  assert.equal(db.prepare('SELECT plan FROM orgs WHERE id = 42').get().plan, 'free');
}

for (const [status, expectedPlan] of [
  ['active', 'pro'],
  ['trialing', 'pro'],
  ['past_due', 'pro'],
  ['unpaid', 'free'],
  ['canceled', 'free'],
  ['incomplete_expired', 'free'],
]) {
  const db = database();
  const payload = eventPayload({
    id: `evt_subscription_${status}`,
    type: 'customer.subscription.updated',
    data: { object: { metadata: { orgId: '42' }, status } },
  });
  const result = processStripeWebhook({
    db,
    rawBody: Buffer.from(payload),
    signatureHeader: signatureFor(payload),
    webhookSecret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });
  assert.equal(result.plan, expectedPlan, status);
}

{
  const db = database();
  const payload = eventPayload({
    id: 'evt_unrelated',
    type: 'invoice.created',
    data: { object: {} },
  });
  const result = processStripeWebhook({
    db,
    rawBody: Buffer.from(payload),
    signatureHeader: signatureFor(payload),
    webhookSecret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
  });
  assert.deepEqual(result, {
    received: true,
    duplicate: false,
    organizationId: null,
    plan: null,
    eventType: 'invoice.created',
  });
}

for (const [name, payload] of [
  ['missing event id', JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } })],
  ['missing organization metadata', eventPayload({ data: { object: {} } })],
  ['unknown organization', eventPayload({ data: { object: { metadata: { orgId: '999' } } } })],
  ['invalid JSON', '{not-json'],
]) {
  const db = database();
  assert.throws(
    () => processStripeWebhook({
      db,
      rawBody: Buffer.from(payload),
      signatureHeader: signatureFor(payload),
      webhookSecret: WEBHOOK_SECRET,
      nowSeconds: NOW_SECONDS,
    }),
    (error) => error instanceof StripeWebhookError,
    name,
  );
}
