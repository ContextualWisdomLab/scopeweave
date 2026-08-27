import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { installCalendarSubscriptionSchema } from '../../server/calendar_subscription_sqlite.mjs';

test('calendar subscription schema keeps exactly one secret-hash index', () => {
  const db = new DatabaseSync(':memory:');
  installCalendarSubscriptionSchema(db);

  const indexes = db.prepare("PRAGMA index_list('calendar_subscriptions')").all();
  const secretHashIndexes = indexes.filter(({ name }) => {
    const quotedName = String(name).replaceAll('"', '""');
    const columns = db.prepare(`PRAGMA index_info("${quotedName}")`).all().map(({ name: columnName }) => columnName);
    return columns.length === 1 && columns[0] === 'secret_hash';
  });

  assert.equal(
    secretHashIndexes.length,
    1,
    'credential lookup must maintain exactly one secret_hash B-tree',
  );
  assert.equal(Number(secretHashIndexes[0].unique), 1, 'credential hashes must remain unique');
  assert.equal(secretHashIndexes[0].name, 'calendar_subscription_secret_hash_index');
  db.close();
});
