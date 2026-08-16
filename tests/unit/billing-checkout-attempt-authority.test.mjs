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
  database.exec('CREATE TABLE orgs (id INTEGER PRIMARY KEY)');
  database.prepare('INSERT INTO orgs(id) VALUES(?)').run(1);
  installBillingCheckoutAttemptSchema(database);
  return database;
}

test('checkout-attempt authority rejects non-number/string values before tenant lookup', () => {
  const database = authorityDatabase();
  let uuidCounter = 0;
  const repository = createSqliteBillingCheckoutAttemptRepository(database, {
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    now: () => 1_000,
  });

  for (const organizationId of [true, new Number(1), [1]]) {
    assert.throws(
      () => repository.startAttempt({ organizationId, priceId: 'price_pro' }),
      TypeError,
      'tenant authority must not be synthesized through JavaScript numeric coercion',
    );
  }

  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM billing_checkout_attempts').get().count,
    0,
    'malformed local authority cannot create provider retry authority',
  );
  database.close();
});
