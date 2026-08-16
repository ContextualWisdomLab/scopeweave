import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  StripeWebhookLedgerError,
  createSqliteStripeWebhookEventRepository,
  installStripeWebhookEventSchema,
} from '../../server/stripe_webhook_event_ledger.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function event(overrides = {}) {
  return {
    id: 'evt_scopeweave_1',
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: 1_787_000_000,
    data: { object: { id: 'sub_scopeweave_1', object: 'subscription' } },
    request: { id: 'req_scopeweave_1', idempotency_key: null },
    type: 'customer.subscription.updated',
    ...overrides,
  };
}

function setup(now = () => 1_787_000_100_000) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  installStripeWebhookEventSchema(database);
  const repository = createSqliteStripeWebhookEventRepository(database, { now });
  return { database, repository };
}

test('schema is bootstrap-installed, 3NF-normalized, and does not retain raw payloads', () => {
  const { database } = setup();
  installStripeWebhookEventSchema(database);

  const eventColumns = database.prepare("PRAGMA table_info('billing_stripe_webhook_events')").all().map((row) => row.name);
  const deliveryColumns = database.prepare("PRAGMA table_info('billing_stripe_webhook_deliveries')").all().map((row) => row.name);

  assert.deepEqual(eventColumns, [
    'event_id', 'provider_created_at_sec', 'event_type', 'object_id', 'object_type',
    'api_version', 'request_id', 'payload_sha256', 'first_received_at_ms',
  ]);
  assert.deepEqual(deliveryColumns, [
    'delivery_id', 'event_id', 'received_at_ms', 'replay_state',
  ]);
  assert.equal(eventColumns.some((name) => /raw|payload_json|body/i.test(name)), false);
});

test('first verified event stores bounded immutable metadata and one non-replay delivery', () => {
  const { database, repository } = setup();
  const result = repository.recordVerifiedEvent({ event: event(), payloadSha256: HASH_A });

  assert.equal(result.replayed, false);
  assert.equal(result.eventId, 'evt_scopeweave_1');
  assert.deepEqual({ ...database.prepare('SELECT * FROM billing_stripe_webhook_events').get() }, {
    event_id: 'evt_scopeweave_1',
    provider_created_at_sec: 1_787_000_000,
    event_type: 'customer.subscription.updated',
    object_id: 'sub_scopeweave_1',
    object_type: 'subscription',
    api_version: '2025-02-24.acacia',
    request_id: 'req_scopeweave_1',
    payload_sha256: HASH_A,
    first_received_at_ms: 1_787_000_100_000,
  });
  assert.deepEqual({ ...database.prepare('SELECT event_id, replay_state FROM billing_stripe_webhook_deliveries').get() }, {
    event_id: 'evt_scopeweave_1', replay_state: 'first_delivery',
  });
});

test('exact duplicate event IDs are idempotent and recorded as replay evidence', () => {
  const { database, repository } = setup();
  repository.recordVerifiedEvent({ event: event(), payloadSha256: HASH_A });
  const replay = repository.recordVerifiedEvent({ event: event(), payloadSha256: HASH_A });

  assert.equal(replay.replayed, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_webhook_events').get().count, 1);
  assert.deepEqual(
    database.prepare('SELECT replay_state FROM billing_stripe_webhook_deliveries ORDER BY delivery_id').all()
      .map((row) => ({ ...row })),
    [
      { replay_state: 'first_delivery' },
      { replay_state: 'duplicate_event' },
    ],
  );
});

test('same event ID with a different verified payload hash fails closed without recording a false replay', () => {
  const { database, repository } = setup();
  repository.recordVerifiedEvent({ event: event(), payloadSha256: HASH_A });

  assert.throws(
    () => repository.recordVerifiedEvent({ event: event(), payloadSha256: HASH_B }),
    (error) => error instanceof StripeWebhookLedgerError && error.code === 'stripe_webhook_event_conflict' && error.status === 409,
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_webhook_deliveries').get().count, 1);
});

test('malformed provider ordering, object identity, and request envelopes fail before persistence', () => {
  const { database, repository } = setup();
  const invalid = [
    event({ created: -1 }),
    event({ created: 1.5 }),
    event({ data: {} }),
    event({ data: { object: { id: '', object: 'subscription' } } }),
    event({ request: { id: 'x'.repeat(256) } }),
    event({ request: 'req_not_an_object' }),
    event({ request: [] }),
    event({ request: {} }),
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => repository.recordVerifiedEvent({ event: candidate, payloadSha256: HASH_A }),
      (error) => error instanceof StripeWebhookLedgerError && error.code === 'stripe_webhook_event_invalid' && error.status === 400,
    );
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM billing_stripe_webhook_events').get().count, 0);
});
