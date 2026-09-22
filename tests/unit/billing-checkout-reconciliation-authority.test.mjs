import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  createSqliteBillingCheckoutAttemptRepository,
  installBillingCheckoutAttemptSchema,
} from '../../server/billing_checkout_attempt.mjs';

function authorityDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  database.exec('CREATE TABLE orgs (id INTEGER PRIMARY KEY)');
  database.prepare('INSERT INTO users(id) VALUES(?)').run(41);
  database.prepare('INSERT INTO orgs(id) VALUES(?)').run(1);
  installBillingCheckoutAttemptSchema(database);
  return database;
}

function repositoryFor(database) {
  let uuidCounter = 0;
  return createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    now: () => 1_000,
  });
}

test('checkout reconciliation rejects JavaScript-coerced tenant authority before persistence lookup', () => {
  const database = authorityDatabase();
  const repository = repositoryFor(database);

  for (const organizationId of [true, new Number(1), [1]]) {
    assert.throws(
      () => repository.startAttempt({ organizationId, priceId: 'price_pro' }),
      TypeError,
    );
    assert.throws(
      () => repository.countReconciliationRequired({ organizationId }),
      TypeError,
    );
    assert.throws(
      () => repository.listReconciliationRequired({ organizationId }),
      TypeError,
    );
  }

  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM billing_checkout_attempts').get().count,
    0,
    'malformed local tenant authority cannot create provider retry authority',
  );
  database.close();
});

test('checkout reconciliation rejects JavaScript-coerced operator authority before state lookup', () => {
  const database = authorityDatabase();
  const repository = repositoryFor(database);

  for (const resolvedByUserId of [true, new Number(41), [41]]) {
    assert.throws(
      () => repository.resolveReconciliation({
        organizationId: 1,
        attemptId: 'attempt_unknown',
        resolvedByUserId,
        outcome: 'provider_failed',
        evidenceReference: 'stripe:test:authority',
      }),
      TypeError,
    );
  }

  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM billing_checkout_reconciliation_events').get().count,
    0,
    'malformed operator authority cannot create reconciliation audit evidence',
  );
  database.close();
});
