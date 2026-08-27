import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createCalendarSubscriptionService } from '../../server/calendar_subscription_domain.mjs';
import {
  createSqliteCalendarSubscriptionAuthorizationPort,
  createSqliteCalendarSubscriptionMembershipPort,
  createSqliteCalendarSubscriptionRepository,
  installCalendarSubscriptionSchema,
} from '../../server/calendar_subscription_sqlite.mjs';

function installFixture(db) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      token_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE orgs (id INTEGER PRIMARY KEY);
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
  installCalendarSubscriptionSchema(db);
}

function deterministicRandomSource() {
  let call = 0;
  return {
    randomBytes(length) {
      call += 1;
      return new Uint8Array(length).fill(call);
    },
  };
}

test('high-frequency calendar polling retains bounded recent usage evidence without amplifying lifecycle outbox', async () => {
  const db = new DatabaseSync(':memory:');
  installFixture(db);
  const clock = {
    value: 1_000_000,
    nowMs() {
      return this.value;
    },
  };
  const repository = createSqliteCalendarSubscriptionRepository(db, { usageEventLimit: 2 });
  const service = createCalendarSubscriptionService({
    repository,
    clock,
    randomSource: deterministicRandomSource(),
    auditSink: { record: async () => {} },
    projectAuthorization: createSqliteCalendarSubscriptionAuthorizationPort(db),
    membershipRevocation: createSqliteCalendarSubscriptionMembershipPort(db),
  });

  const created = await service.create({
    subjectId: '1',
    projectId: '1000',
    name: 'Frequently polled feed',
    expiresAtMs: 2_000_000,
  });

  for (const nowMs of [1_000_001, 1_000_002, 1_000_003]) {
    clock.value = nowMs;
    await service.authorize({ secret: created.secret, projectId: '1000' });
  }

  const usageEvents = db
    .prepare('SELECT used_at_ms FROM subscription_usage_events ORDER BY usage_event_id')
    .all()
    .map(({ used_at_ms }) => used_at_ms);
  assert.deepEqual(
    usageEvents,
    [1_000_002, 1_000_003],
    'only the configured recent-use window is retained for a repeatedly polled feed',
  );
  assert.equal(
    db.prepare('SELECT last_used_at_ms FROM calendar_subscriptions WHERE subscription_id = ?')
      .get(created.subscriptionId).last_used_at_ms,
    1_000_003,
    'current lifecycle state preserves the exact last-use timestamp independently of history pruning',
  );
  const outboxTypes = db
    .prepare('SELECT event_type FROM calendar_subscription_audit_outbox ORDER BY audit_event_id')
    .all()
    .map(({ event_type }) => event_type);
  assert.deepEqual(
    outboxTypes,
    ['created'],
    'read polling must not create an undelivered lifecycle-outbox row on every authorization',
  );
  db.close();
});
