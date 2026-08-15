import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  BILLING_CHECKOUT_REUSE_WINDOW_MS,
  createSqliteBillingCheckoutAttemptRepository,
  installBillingCheckoutAttemptSchema,
} from '../../server/billing_checkout_attempt.mjs';

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  database.exec('CREATE TABLE orgs (id INTEGER PRIMARY KEY)');
  database.prepare('INSERT INTO users(id) VALUES(?)').run(41);
  database.prepare('INSERT INTO users(id) VALUES(?)').run(42);
  database.prepare('INSERT INTO orgs(id) VALUES(?)').run(7);
  database.prepare('INSERT INTO orgs(id) VALUES(?)').run(8);
  installBillingCheckoutAttemptSchema(database);
  return database;
}

function deterministicIds() {
  const values = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
  ];
  return () => {
    const value = values.shift();
    assert.ok(value, 'test UUID source must not be exhausted');
    return value;
  };
}

function createRepository(database, initialNow = 1_000_000) {
  let nowMs = initialNow;
  const repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: deterministicIds(),
    now: () => nowMs,
  });
  return {
    repository,
    advanceBy(milliseconds) {
      nowMs += milliseconds;
    },
    setNow(milliseconds) {
      nowMs = milliseconds;
    },
  };
}

function forceReconciliation(repository, advanceBy, organizationId = 7, priceId = 'price_pro') {
  const attempt = repository.startAttempt({ organizationId, priceId });
  advanceBy(BILLING_CHECKOUT_REUSE_WINDOW_MS);
  assert.throws(
    () => repository.startAttempt({ organizationId, priceId }),
    (error) => error?.code === 'billing_checkout_reconciliation_required',
  );
  return attempt;
}

test('reconciliation schema is normalized and audit events never duplicate provider secrets', () => {
  const database = createDatabase();
  const table = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'billing_checkout_reconciliation_events'",
  ).get();
  assert.ok(table, 'reconciliation audit table must be installed during bootstrap');
  assert.match(table.sql, /attempt_id TEXT NOT NULL UNIQUE/);
  assert.match(table.sql, /resolved_by_user_id INTEGER NOT NULL/);
  assert.match(table.sql, /evidence_reference TEXT NOT NULL/);

  const columns = database.prepare("PRAGMA table_info('billing_checkout_reconciliation_events')")
    .all()
    .map((row) => row.name);
  assert.deepEqual(columns, [
    'reconciliation_event_id',
    'attempt_id',
    'resolved_by_user_id',
    'provider_resolution',
    'provider_session_id',
    'evidence_reference',
    'resolved_at_ms',
  ]);
  assert.equal(columns.some((name) => /idempotency|secret|token|hash/i.test(name)), false);

  const foreignKeys = database.prepare("PRAGMA foreign_key_list('billing_checkout_reconciliation_events')")
    .all();
  assert.equal(foreignKeys.some((row) => row.table === 'billing_checkout_attempts' && row.from === 'attempt_id'), true);
  assert.equal(foreignKeys.some((row) => row.table === 'users' && row.from === 'resolved_by_user_id'), true);
});

test('inspection and metric expose reconciliation work without idempotency authority', () => {
  const database = createDatabase();
  const { repository, advanceBy } = createRepository(database);
  const attempt = forceReconciliation(repository, advanceBy);

  assert.equal(repository.countReconciliationRequired(), 1);
  assert.equal(repository.countReconciliationRequired({ organizationId: 7 }), 1);
  assert.equal(repository.countReconciliationRequired({ organizationId: 8 }), 0);

  const rows = repository.listReconciliationRequired({ organizationId: 7, limit: 10 });
  assert.deepEqual(rows, [{
    attemptId: attempt.attemptId,
    priceId: 'price_pro',
    createdAtMs: 1_000_000,
    updatedAtMs: 1_000_000 + BILLING_CHECKOUT_REUSE_WINDOW_MS,
  }]);
  assert.equal(JSON.stringify(rows).includes(attempt.idempotencyKey), false);
  assert.deepEqual(repository.listReconciliationRequired({ organizationId: 8 }), []);
});

test('authoritative success resolution is tenant-scoped, audited, and unblocks a fresh checkout identity', () => {
  const database = createDatabase();
  const { repository, advanceBy } = createRepository(database);
  const attempt = forceReconciliation(repository, advanceBy);

  assert.throws(
    () => repository.resolveReconciliation({
      organizationId: 8,
      attemptId: attempt.attemptId,
      resolvedByUserId: 41,
      outcome: 'provider_succeeded',
      providerSessionId: 'cs_live_wrong_tenant',
      evidenceReference: 'stripe:event:evt_wrong_tenant',
    }),
    /reconciliation-required checkout attempt/i,
  );
  assert.equal(repository.countReconciliationRequired({ organizationId: 7 }), 1);

  repository.resolveReconciliation({
    organizationId: 7,
    attemptId: attempt.attemptId,
    resolvedByUserId: 41,
    outcome: 'provider_succeeded',
    providerSessionId: 'cs_live_authoritative_123',
    evidenceReference: 'stripe:event:evt_authoritative_123',
  });

  assert.equal(repository.countReconciliationRequired({ organizationId: 7 }), 0);
  const resolved = database.prepare(`
    SELECT attempt_state, provider_session_id
    FROM billing_checkout_attempts
    WHERE attempt_id = ?
  `).get(attempt.attemptId);
  assert.deepEqual({ ...resolved }, {
    attempt_state: 'provider_succeeded',
    provider_session_id: 'cs_live_authoritative_123',
  });

  const audit = database.prepare(`
    SELECT attempt_id, resolved_by_user_id, provider_resolution,
           provider_session_id, evidence_reference, resolved_at_ms
    FROM billing_checkout_reconciliation_events
    WHERE attempt_id = ?
  `).get(attempt.attemptId);
  assert.deepEqual({ ...audit }, {
    attempt_id: attempt.attemptId,
    resolved_by_user_id: 41,
    provider_resolution: 'provider_succeeded',
    provider_session_id: 'cs_live_authoritative_123',
    evidence_reference: 'stripe:event:evt_authoritative_123',
    resolved_at_ms: 1_000_000 + BILLING_CHECKOUT_REUSE_WINDOW_MS,
  });
  assert.equal(JSON.stringify(audit).includes(attempt.idempotencyKey), false);

  const fresh = repository.startAttempt({ organizationId: 7, priceId: 'price_pro' });
  assert.notEqual(fresh.attemptId, attempt.attemptId);
  assert.notEqual(fresh.idempotencyKey, attempt.idempotencyKey);
});

test('authoritative failure resolution closes the held identity without inventing a provider session', () => {
  const database = createDatabase();
  const { repository, advanceBy } = createRepository(database, 2_000_000);
  const attempt = forceReconciliation(repository, advanceBy);

  repository.resolveReconciliation({
    organizationId: 7,
    attemptId: attempt.attemptId,
    resolvedByUserId: 42,
    outcome: 'provider_failed',
    evidenceReference: 'stripe:request-log:req_confirmed_failed',
  });

  const resolved = database.prepare(`
    SELECT attempt_state, provider_session_id
    FROM billing_checkout_attempts
    WHERE attempt_id = ?
  `).get(attempt.attemptId);
  assert.deepEqual({ ...resolved }, {
    attempt_state: 'provider_failed',
    provider_session_id: null,
  });
  const audit = database.prepare(`
    SELECT provider_resolution, provider_session_id, resolved_by_user_id
    FROM billing_checkout_reconciliation_events
    WHERE attempt_id = ?
  `).get(attempt.attemptId);
  assert.deepEqual({ ...audit }, {
    provider_resolution: 'provider_failed',
    provider_session_id: null,
    resolved_by_user_id: 42,
  });
});

test('resolution validates evidence, actor, outcome, provider session, limits, and tenant identifiers', () => {
  const database = createDatabase();
  const { repository, advanceBy } = createRepository(database);
  const attempt = forceReconciliation(repository, advanceBy);

  const base = {
    organizationId: 7,
    attemptId: attempt.attemptId,
    resolvedByUserId: 41,
    outcome: 'provider_failed',
    evidenceReference: 'stripe:event:evt_known_failure',
  };
  const invalidInputs = [
    [{ ...base, organizationId: 0 }, /organizationId/],
    [{ ...base, attemptId: '' }, /attemptId/],
    [{ ...base, resolvedByUserId: 0 }, /resolvedByUserId/],
    [{ ...base, outcome: 'unknown' }, /outcome/],
    [{ ...base, evidenceReference: '   ' }, /evidenceReference/],
    [{ ...base, evidenceReference: 'stripe:event:\nforged' }, /evidenceReference/],
    [{ ...base, evidenceReference: 'x'.repeat(513) }, /evidenceReference/],
    [{ ...base, outcome: 'provider_succeeded' }, /providerSessionId/],
    [{ ...base, outcome: 'provider_failed', providerSessionId: 'cs_should_not_exist' }, /providerSessionId/],
  ];
  for (const [input, expected] of invalidInputs) {
    assert.throws(() => repository.resolveReconciliation(input), expected);
  }
  for (const limit of [0, -1, 101, 1.5]) {
    assert.throws(
      () => repository.listReconciliationRequired({ organizationId: 7, limit }),
      /limit/,
    );
  }
  assert.throws(
    () => repository.countReconciliationRequired({ organizationId: -1 }),
    /organizationId/,
  );
  assert.equal(repository.countReconciliationRequired({ organizationId: 7 }), 1);
});

test('audit persistence failure rolls the state transition back and clock rollback stays monotonic', () => {
  const database = createDatabase();
  const { repository, advanceBy, setNow } = createRepository(database, 8_000_000);
  const attempt = forceReconciliation(repository, advanceBy);

  assert.throws(
    () => repository.resolveReconciliation({
      organizationId: 7,
      attemptId: attempt.attemptId,
      resolvedByUserId: 999,
      outcome: 'provider_failed',
      evidenceReference: 'stripe:event:evt_missing_actor',
    }),
    /FOREIGN KEY|constraint/i,
  );
  assert.equal(repository.countReconciliationRequired({ organizationId: 7 }), 1);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM billing_checkout_reconciliation_events').get().n,
    0,
  );

  setNow(1);
  repository.resolveReconciliation({
    organizationId: 7,
    attemptId: attempt.attemptId,
    resolvedByUserId: 41,
    outcome: 'provider_failed',
    evidenceReference: 'stripe:event:evt_clock_rollback_resolved',
  });
  const timestamps = database.prepare(`
    SELECT a.created_at_ms, a.updated_at_ms, e.resolved_at_ms
    FROM billing_checkout_attempts a
    JOIN billing_checkout_reconciliation_events e ON e.attempt_id = a.attempt_id
    WHERE a.attempt_id = ?
  `).get(attempt.attemptId);
  assert.equal(timestamps.updated_at_ms >= timestamps.created_at_ms, true);
  assert.equal(timestamps.resolved_at_ms, timestamps.updated_at_ms);
});
