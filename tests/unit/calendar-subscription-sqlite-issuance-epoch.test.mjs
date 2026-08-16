import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  createSqliteCalendarSubscriptionRepository,
  installCalendarSubscriptionSchema,
} from '../../server/calendar_subscription_sqlite.mjs';

function installFixture(database) {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      token_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE orgs (
      id INTEGER PRIMARY KEY
    );
    CREATE TABLE memberships (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(org_id, user_id)
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE
    );
    INSERT INTO users(id, token_version) VALUES (1, 0);
    INSERT INTO orgs(id) VALUES (10);
    INSERT INTO memberships(id, org_id, user_id) VALUES (100, 10, 1);
    INSERT INTO projects(id, org_id) VALUES (1000, 10);
  `);
  installCalendarSubscriptionSchema(database);
}

const baseRecord = (overrides = {}) => ({
  subscription_id: 'csub_00112233445566778899aabbccddeeff',
  secret_hash: 'a'.repeat(64),
  subject_id: '1',
  project_id: '1000',
  name: 'Primary calendar',
  purpose: 'calendar_read',
  audience: 'scopeweave:calendar',
  membership_version: '100:0',
  created_at_ms: 1_000_000,
  expires_at_ms: 2_000_000,
  last_used_at_ms: null,
  rotated_at_ms: null,
  revoked_at_ms: null,
  ...overrides,
});

test('omitted parent-domain purpose still persists as calendar_read', async () => {
  const database = new DatabaseSync(':memory:');
  installFixture(database);
  const repository = createSqliteCalendarSubscriptionRepository(database);
  const { purpose, ...recordWithoutPurpose } = baseRecord();

  await repository.insertSubscription(recordWithoutPurpose);
  const stored = await repository.findSubscriptionByHash('a'.repeat(64));

  assert.equal(purpose, 'calendar_read');
  assert.equal(stored.purpose, 'calendar_read');
  database.close();
});

test('SQLite subscription storage persists the calendar_read purpose as authorization state', async () => {
  const database = new DatabaseSync(':memory:');
  installFixture(database);
  const repository = createSqliteCalendarSubscriptionRepository(database);

  await repository.insertSubscription(baseRecord());
  const stored = await repository.findSubscriptionByHash('a'.repeat(64));

  assert.equal(stored.purpose, 'calendar_read');
  assert.equal(
    database.prepare('SELECT purpose FROM calendar_subscriptions WHERE subscription_id = ?')
      .get(baseRecord().subscription_id).purpose,
    'calendar_read',
  );
  database.close();
});

test('usage is bound to stored purpose and issuance membership epoch across remove-then-rejoin', async () => {
  const database = new DatabaseSync(':memory:');
  installFixture(database);
  const repository = createSqliteCalendarSubscriptionRepository(database);
  await repository.insertSubscription(baseRecord());

  const wrongPurpose = await repository.recordUsageAtomically('a'.repeat(64), {
    now_ms: 1_100_000,
    project_id: '1000',
    purpose: 'session',
    audience: 'scopeweave:calendar',
    membership_version: '100:0',
  });
  assert.equal(wrongPurpose, null, 'calendar credentials must not authorize a broader purpose');

  database.prepare('DELETE FROM memberships WHERE id = 100').run();
  database.prepare('INSERT INTO memberships(id, org_id, user_id) VALUES (101, 10, 1)').run();
  const afterRejoin = await repository.recordUsageAtomically('a'.repeat(64), {
    now_ms: 1_200_000,
    project_id: '1000',
    purpose: 'calendar_read',
    audience: 'scopeweave:calendar',
    membership_version: '100:0',
  });
  assert.equal(afterRejoin, null, 'remove-then-rejoin must not revive the issuance epoch');

  const rotated = await repository.rotateSubscriptionAtomically(baseRecord().subscription_id, {
    subject_id: '1',
    project_id: '1000',
    new_secret_hash: 'b'.repeat(64),
    now_ms: 1_300_000,
    expires_at_ms: 2_300_000,
    purpose: 'calendar_read',
    membership_version: '101:0',
  });
  assert.equal(rotated.membership_version, '101:0');
  assert.equal(rotated.purpose, 'calendar_read');

  const rebound = await repository.recordUsageAtomically('b'.repeat(64), {
    now_ms: 1_400_000,
    project_id: '1000',
    purpose: 'calendar_read',
    audience: 'scopeweave:calendar',
    membership_version: '101:0',
  });
  assert.equal(rebound.subscription_id, baseRecord().subscription_id);
  database.close();
});

test('revocation reports only the first state transition while preserving the original timestamp', async () => {
  const database = new DatabaseSync(':memory:');
  installFixture(database);
  const repository = createSqliteCalendarSubscriptionRepository(database);
  await repository.insertSubscription(baseRecord());

  const first = await repository.revokeSubscriptionAtomically(baseRecord().subscription_id, {
    subject_id: '1',
    project_id: '1000',
    now_ms: 1_500_000,
  });
  const second = await repository.revokeSubscriptionAtomically(baseRecord().subscription_id, {
    subject_id: '1',
    project_id: '1000',
    now_ms: 1_600_000,
  });

  assert.equal(first.revocation_applied, true);
  assert.equal(second.revocation_applied, false);
  assert.equal(second.revoked_at_ms, 1_500_000);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM calendar_subscription_audit_outbox WHERE event_type = 'revoked'")
      .get().count,
    1,
  );
  database.close();
});
