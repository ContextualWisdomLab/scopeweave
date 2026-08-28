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
  database.exec('CREATE TABLE orgs (id INTEGER PRIMARY KEY)');
  database.prepare('INSERT INTO orgs(id) VALUES(?)').run(7);
  database.prepare('INSERT INTO orgs(id) VALUES(?)').run(8);
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
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',
  ];
  return () => {
    const value = values.shift();
    assert.ok(value, 'test UUID source must not be exhausted');
    return value;
  };
}

function expectReconciliationRequired(run) {
  assert.throws(run, (error) => {
    assert.equal(error.code, 'billing_checkout_reconciliation_required');
    assert.match(error.message, /reconcil/i);
    return true;
  });
}

test('checkout-attempt bootstrap owns only compliant normalized objects', () => {
  const database = createDatabase();
  installBillingCheckoutAttemptSchema(database);
  installBillingCheckoutAttemptSchema(database);

  const table = database.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = 'billing_checkout_attempts'",
  ).get();
  assert.equal(table.name, 'billing_checkout_attempts');
  assert.match(table.sql, /CHECK\s*\(attempt_state IN \('pending','provider_succeeded','provider_failed','reconciliation_required'\)\)/);

  const index = database.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'billing_checkout_unresolved_attempts'",
  ).get();
  assert.equal(index.name, 'billing_checkout_unresolved_attempts');
  assert.match(index.sql, /WHERE attempt_state IN \('pending','reconciliation_required'\)/);

  const columns = database.prepare("PRAGMA table_info('billing_checkout_attempts')").all().map((row) => row.name);
  assert.deepEqual(columns, [
    'attempt_id',
    'organization_id',
    'price_id',
    'idempotency_key',
    'attempt_state',
    'provider_session_id',
    'created_at_ms',
    'updated_at_ms',
  ]);
  assert.equal(columns.some((name) => /secret|token/i.test(name)), false);

  const foreignKeys = database.prepare("PRAGMA foreign_key_list('billing_checkout_attempts')").all();
  assert.equal(foreignKeys.length, 1);
  assert.equal(foreignKeys[0].table, 'orgs');
  assert.equal(foreignKeys[0].from, 'organization_id');
  assert.equal(foreignKeys[0].on_delete, 'CASCADE');
});

test('repository never performs request-time schema installation', () => {
  const database = createDatabase();
  const repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: deterministicIds(),
    now: () => 1_000,
  });

  assert.throws(
    () => repository.startAttempt({ organizationId: 7, priceId: 'price_pro' }),
    /billing_checkout_attempts/,
  );
  const table = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'billing_checkout_attempts'",
  ).get();
  assert.equal(table, undefined);
});

test('pending uncertain attempts reuse one durable Stripe idempotency key inside the safe window', () => {
  const database = createDatabase();
  installBillingCheckoutAttemptSchema(database);
  let nowMs = 1_000_000;
  const repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: deterministicIds(),
    now: () => nowMs,
  });

  const first = repository.startAttempt({ organizationId: 7, priceId: 'price_pro' });
  assert.deepEqual(first, {
    attemptId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
    state: 'pending',
    reused: false,
  });

  nowMs += BILLING_CHECKOUT_REUSE_WINDOW_MS - 1;
  const retry = repository.startAttempt({ organizationId: 7, priceId: 'price_pro' });
  assert.deepEqual(retry, { ...first, reused: true });

  const otherTenant = repository.startAttempt({ organizationId: 8, priceId: 'price_pro' });
  assert.notEqual(otherTenant.attemptId, first.attemptId);
  assert.notEqual(otherTenant.idempotencyKey, first.idempotencyKey);

  const persisted = database.prepare(
    'SELECT organization_id, price_id, idempotency_key, attempt_state FROM billing_checkout_attempts WHERE attempt_id = ?',
  ).get(first.attemptId);
  assert.deepEqual({ ...persisted }, {
    organization_id: 7,
    price_id: 'price_pro',
    idempotency_key: first.idempotencyKey,
    attempt_state: 'pending',
  });
});

test('terminal provider outcomes close the retry identity and a later checkout gets fresh authority', () => {
  const database = createDatabase();
  installBillingCheckoutAttemptSchema(database);
  let nowMs = 2_000_000;
  const repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: deterministicIds(),
    now: () => nowMs,
  });

  const successAttempt = repository.startAttempt({ organizationId: 7, priceId: 'price_pro' });
  repository.markProviderSucceeded({
    attemptId: successAttempt.attemptId,
    providerSessionId: 'cs_test_success_123',
  });
  const successRow = database.prepare(
    'SELECT attempt_state, provider_session_id FROM billing_checkout_attempts WHERE attempt_id = ?',
  ).get(successAttempt.attemptId);
  assert.deepEqual({ ...successRow }, {
    attempt_state: 'provider_succeeded',
    provider_session_id: 'cs_test_success_123',
  });

  nowMs += 1;
  const afterSuccess = repository.startAttempt({ organizationId: 7, priceId: 'price_pro' });
  assert.notEqual(afterSuccess.idempotencyKey, successAttempt.idempotencyKey);

  repository.markProviderFailed({ attemptId: afterSuccess.attemptId });
  nowMs += 1;
  const afterFailure = repository.startAttempt({ organizationId: 7, priceId: 'price_pro' });
  assert.notEqual(afterFailure.idempotencyKey, afterSuccess.idempotencyKey);
});

test('stale uncertain attempts fail closed for reconciliation instead of minting a duplicate key', () => {
  const database = createDatabase();
  installBillingCheckoutAttemptSchema(database);
  let nowMs = 3_000_000;
  const repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: deterministicIds(),
    now: () => nowMs,
  });

  const oldAttempt = repository.startAttempt({ organizationId: 7, priceId: 'price_pro' });
  nowMs += BILLING_CHECKOUT_REUSE_WINDOW_MS;
  expectReconciliationRequired(
    () => repository.startAttempt({ organizationId: 7, priceId: 'price_pro' }),
  );

  const rows = database.prepare(`
    SELECT attempt_id, idempotency_key, attempt_state
    FROM billing_checkout_attempts
    WHERE organization_id = ? AND price_id = ?
  `).all(7, 'price_pro');
  assert.deepEqual(rows.map((row) => ({ ...row })), [{
    attempt_id: oldAttempt.attemptId,
    idempotency_key: oldAttempt.idempotencyKey,
    attempt_state: 'reconciliation_required',
  }]);

  nowMs += 1;
  expectReconciliationRequired(
    () => repository.startAttempt({ organizationId: 7, priceId: 'price_pro' }),
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM billing_checkout_attempts WHERE organization_id = ?').get(7).n,
    1,
    'retries cannot create a second attempt until authoritative reconciliation resolves the first',
  );
});

test('clock rollback requires reconciliation instead of guessing the provider retention age', () => {
  const database = createDatabase();
  installBillingCheckoutAttemptSchema(database);
  let nowMs = 5_000_000;
  const repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: deterministicIds(),
    now: () => nowMs,
  });

  const first = repository.startAttempt({ organizationId: 7, priceId: 'price_pro' });
  nowMs -= 1_000;
  expectReconciliationRequired(
    () => repository.startAttempt({ organizationId: 7, priceId: 'price_pro' }),
  );

  const row = database.prepare(
    'SELECT attempt_id, idempotency_key, attempt_state FROM billing_checkout_attempts WHERE attempt_id = ?',
  ).get(first.attemptId);
  assert.deepEqual({ ...row }, {
    attempt_id: first.attemptId,
    idempotency_key: first.idempotencyKey,
    attempt_state: 'reconciliation_required',
  });
});

test('repository rejects malformed identifiers and impossible terminal transitions', () => {
  const database = createDatabase();
  installBillingCheckoutAttemptSchema(database);
  const repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: deterministicIds(),
    now: () => 4_000_000,
  });

  for (const organizationId of [0, -1, 1.5, 'not-an-id']) {
    assert.throws(
      () => repository.startAttempt({ organizationId, priceId: 'price_pro' }),
      /organizationId/,
    );
  }
  for (const priceId of [null, '   ', 'x'.repeat(256)]) {
    assert.throws(
      () => repository.startAttempt({ organizationId: 7, priceId }),
      /priceId/,
    );
  }

  const attempt = repository.startAttempt({ organizationId: 7, priceId: 'price_pro' });
  for (const providerSessionId of [null, '', 'x'.repeat(256)]) {
    assert.throws(
      () => repository.markProviderSucceeded({ attemptId: attempt.attemptId, providerSessionId }),
      /providerSessionId/,
    );
  }
  repository.markProviderFailed({ attemptId: attempt.attemptId });
  assert.throws(
    () => repository.markProviderSucceeded({ attemptId: attempt.attemptId, providerSessionId: 'cs_too_late' }),
    /pending checkout attempt/,
  );
  assert.throws(
    () => repository.markProviderFailed({ attemptId: 'not-an-attempt' }),
    /pending checkout attempt/,
  );
  assert.throws(
    () => repository.markProviderFailed({ attemptId: '' }),
    /attemptId/,
  );
});

test('dependency seams fail closed and default UUID/clock dependencies are usable', () => {
  const database = createDatabase();
  installBillingCheckoutAttemptSchema(database);

  assert.throws(
    () => createSqliteBillingCheckoutAttemptRepository(null),
    /database/,
  );
  assert.throws(
    () => createSqliteBillingCheckoutAttemptRepository(database, { randomUUID: 'not-a-function' }),
    /randomUUID/,
  );
  assert.throws(
    () => createSqliteBillingCheckoutAttemptRepository(database, { now: 'not-a-function' }),
    /now/,
  );

  const repository = createSqliteBillingCheckoutAttemptRepository(database);
  const attempt = repository.startAttempt({ organizationId: 7, priceId: 'price_default' });
  assert.match(attempt.attemptId, /^[0-9a-f-]{36}$/i);
  assert.match(attempt.idempotencyKey, /^[0-9a-f-]{36}$/i);
  repository.markProviderFailed({ attemptId: attempt.attemptId });
});

test('invalid clock and identifier sources roll back without leaving a pending row', () => {
  let database = createDatabase();
  installBillingCheckoutAttemptSchema(database);
  let repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: deterministicIds(),
    now: () => -1,
  });
  assert.throws(
    () => repository.startAttempt({ organizationId: 7, priceId: 'price_bad_clock' }),
    /clock/,
  );

  database = createDatabase();
  installBillingCheckoutAttemptSchema(database);
  repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: () => '',
    now: () => 6_000_000,
  });
  assert.throws(
    () => repository.startAttempt({ organizationId: 7, priceId: 'price_bad_uuid' }),
    /attemptId/,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM billing_checkout_attempts').get().n,
    0,
  );

  database = createDatabase();
  installBillingCheckoutAttemptSchema(database);
  repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: deterministicIds(),
    now: () => 7_000_000,
  });
  assert.throws(
    () => repository.startAttempt({ organizationId: 999, priceId: 'price_missing_org' }),
    /FOREIGN KEY|constraint/i,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM billing_checkout_attempts').get().n,
    0,
  );
});

test('rollback cleanup aborts the shared transaction and preserves the causal write failure', () => {
  const database = createDatabase();
  installBillingCheckoutAttemptSchema(database);
  database.exec(`
    CREATE TRIGGER billing_checkout_test_attempt_failure
    BEFORE INSERT ON billing_checkout_attempts
    BEGIN
      SELECT RAISE(ABORT, 'causal checkout attempt write failure');
    END;
  `);

  const executed = [];
  const guardedDatabase = {
    prepare: database.prepare.bind(database),
    exec(sql) {
      executed.push(sql);
      if (sql === 'ROLLBACK TO SAVEPOINT billing_checkout_attempt_write') {
        throw new Error('simulated rollback cleanup failure');
      }
      return database.exec(sql);
    },
  };
  const repository = createSqliteBillingCheckoutAttemptRepository(guardedDatabase, {
    randomUUID: deterministicIds(),
    now: () => 8_000_000,
  });

  assert.throws(
    () => repository.startAttempt({ organizationId: 7, priceId: 'price_rollback_failure' }),
    /causal checkout attempt write failure/,
  );
  assert.equal(
    executed.filter((sql) => sql === 'RELEASE SAVEPOINT billing_checkout_attempt_write').length,
    0,
    'failed rollback must not release an unconfirmed savepoint',
  );
  assert.equal(
    executed.filter((sql) => sql === 'ROLLBACK').length,
    1,
    'failed savepoint rollback must abort the shared transaction',
  );
});
