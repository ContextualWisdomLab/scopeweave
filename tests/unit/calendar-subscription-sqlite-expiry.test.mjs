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

test('expired calendar subscription cannot be revived by rotation', async () => {
  const db = new DatabaseSync(':memory:');
  installFixture(db);
  const clock = {
    value: 1_000_000,
    nowMs() {
      return this.value;
    },
  };
  const service = createCalendarSubscriptionService({
    repository: createSqliteCalendarSubscriptionRepository(db),
    clock,
    randomSource: deterministicRandomSource(),
    auditSink: { record: async () => {} },
    projectAuthorization: createSqliteCalendarSubscriptionAuthorizationPort(db),
    membershipRevocation: createSqliteCalendarSubscriptionMembershipPort(db),
  });

  const created = await service.create({
    subjectId: '1',
    projectId: '1000',
    name: 'Expiry boundary',
    expiresAtMs: 1_000_100,
  });
  const before = db.prepare(`
    SELECT secret_hash, expires_at_ms, rotated_at_ms
      FROM calendar_subscriptions
     WHERE subscription_id = ?
  `).get(created.subscriptionId);

  clock.value = created.expiresAtMs;
  await assert.rejects(
    service.rotate({
      subjectId: '1',
      projectId: '1000',
      subscriptionId: created.subscriptionId,
      expiresAtMs: 2_000_000,
    }),
    (error) => error?.code === 'calendar_subscription_not_found' && error?.status === 404,
    'exact expiry must be terminal for rotation as well as authorization',
  );

  const after = db.prepare(`
    SELECT secret_hash, expires_at_ms, rotated_at_ms
      FROM calendar_subscriptions
     WHERE subscription_id = ?
  `).get(created.subscriptionId);
  assert.deepEqual(after, before, 'failed rotation must not revive or mutate expired durable state');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subscription_rotations').get().count, 0);
  assert.deepEqual(
    db.prepare('SELECT event_type FROM calendar_subscription_audit_outbox ORDER BY audit_event_id').all(),
    [{ event_type: 'created' }],
    'failed rotation must not append durable rotation evidence',
  );
  db.close();
});
