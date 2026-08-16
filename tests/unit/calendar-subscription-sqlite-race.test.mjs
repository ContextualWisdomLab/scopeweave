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

function installCoreSchema(database) {
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

function createService(
  database,
  projectAuthorization,
  membershipRevocation = createSqliteCalendarSubscriptionMembershipPort(database),
) {
  return createCalendarSubscriptionService({
    repository: createSqliteCalendarSubscriptionRepository(database),
    clock: { nowMs: () => 1_000_000 },
    randomSource: deterministicRandomSource(),
    auditSink: { record: async () => {} },
    projectAuthorization,
    membershipRevocation,
  });
}

function revokingAuthorization(database) {
  const authorize = createSqliteCalendarSubscriptionAuthorizationPort(database);
  return {
    async assertCanManage(binding) {
      await authorize.assertCanManage(binding);
      database.prepare('DELETE FROM memberships WHERE id = 100').run();
    },
  };
}

function changingMembershipVersionAfterRead(database) {
  const membership = createSqliteCalendarSubscriptionMembershipPort(database);
  return {
    async assertActive(binding) {
      const version = await membership.assertActive(binding);
      database.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = 1').run();
      return version;
    },
  };
}

async function createSubscription(database) {
  const service = createService(
    database,
    createSqliteCalendarSubscriptionAuthorizationPort(database),
  );
  return service.create({
    subjectId: '1',
    projectId: '1000',
    name: 'Race-safe calendar',
    expiresAtMs: 2_000_000,
  });
}

test('list rechecks live membership after the management authorization boundary', async () => {
  const database = new DatabaseSync(':memory:');
  installCoreSchema(database);
  installCalendarSubscriptionSchema(database);
  await createSubscription(database);

  const service = createService(database, revokingAuthorization(database));
  const subscriptions = await service.list({ subjectId: '1', projectId: '1000' });

  assert.deepEqual(
    subscriptions,
    [],
    'membership removed after the preflight authorization must not disclose durable subscription metadata',
  );
  database.close();
});

test('rotate maps a membership-version race through the nondisclosing management boundary', async () => {
  const database = new DatabaseSync(':memory:');
  installCoreSchema(database);
  installCalendarSubscriptionSchema(database);
  const created = await createSubscription(database);
  const before = database.prepare(`
    SELECT secret_hash, membership_version, expires_at_ms, rotated_at_ms
      FROM calendar_subscriptions
     WHERE subscription_id = ?
  `).get(created.subscriptionId);

  const service = createService(
    database,
    createSqliteCalendarSubscriptionAuthorizationPort(database),
    changingMembershipVersionAfterRead(database),
  );
  await assert.rejects(
    service.rotate({
      subjectId: '1',
      projectId: '1000',
      subscriptionId: created.subscriptionId,
      expiresAtMs: 2_500_000,
    }),
    (error) => error?.code === 'calendar_subscription_not_found' && error?.status === 404,
    'a version change after domain preflight must fail through the same tenant-nondisclosing boundary',
  );

  const after = database.prepare(`
    SELECT secret_hash, membership_version, expires_at_ms, rotated_at_ms
      FROM calendar_subscriptions
     WHERE subscription_id = ?
  `).get(created.subscriptionId);
  assert.deepEqual(after, before, 'failed rotation races must leave authorization state unchanged');
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM subscription_rotations').get().count,
    0,
    'failed rotation races must not create lifecycle history',
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM calendar_subscription_audit_outbox WHERE event_type = 'rotated'",
    ).get().count,
    0,
    'failed rotation races must not manufacture durable rotation evidence',
  );
  database.close();
});

test('revoke rechecks live membership before mutating subscription state or audit evidence', async () => {
  const database = new DatabaseSync(':memory:');
  installCoreSchema(database);
  installCalendarSubscriptionSchema(database);
  const created = await createSubscription(database);

  const service = createService(database, revokingAuthorization(database));
  await assert.rejects(
    service.revoke({
      subjectId: '1',
      projectId: '1000',
      subscriptionId: created.subscriptionId,
    }),
    (error) => error?.code === 'calendar_subscription_not_found' && error?.status === 404,
    'membership removed after the preflight authorization must fail through the nondisclosing management boundary',
  );

  const stored = database.prepare(
    'SELECT revoked_at_ms FROM calendar_subscriptions WHERE subscription_id = ?',
  ).get(created.subscriptionId);
  assert.equal(stored.revoked_at_ms, null);
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM calendar_subscription_audit_outbox WHERE event_type = 'revoked'",
    ).get().count,
    0,
    'failed authorization races must not manufacture durable revocation evidence',
  );
  database.close();
});

test('foreign-key enforcement rejects invalid durable subscriptions and missing hashes normalize to null', async () => {
  const database = new DatabaseSync(':memory:');
  installCoreSchema(database);
  installCalendarSubscriptionSchema(database);

  assert.equal(
    database.prepare('PRAGMA foreign_keys').get().foreign_keys,
    1,
    'bootstrap test fixture must exercise SQLite foreign-key enforcement rather than integrity inspection alone',
  );
  assert.throws(
    () => database.prepare(`
      INSERT INTO calendar_subscriptions(
        subscription_id, secret_hash, subject_id, project_id, name, purpose, audience,
        membership_version, created_at_ms, expires_at_ms, last_used_at_ms,
        rotated_at_ms, revoked_at_ms
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)
    `).run(
      'csub_missing_project',
      'c'.repeat(64),
      1,
      999999,
      'Missing project',
      'calendar_read',
      'scopeweave:calendar',
      '100:0',
      1_000_000,
      2_000_000,
      null,
    ),
    /FOREIGN KEY constraint failed/,
  );

  const repository = createSqliteCalendarSubscriptionRepository(database);
  assert.equal(
    await repository.findSubscriptionByHash('f'.repeat(64)),
    null,
    'an unknown hash must retain the repository missing-row contract',
  );
  database.close();
});

test('savepoint release cleanup failure never masks the causal operation error', async () => {
  const database = new DatabaseSync(':memory:');
  installCoreSchema(database);
  installCalendarSubscriptionSchema(database);
  const created = await createSubscription(database);
  database.exec(`
    CREATE TRIGGER calendar_subscription_test_abort_usage_cleanup
    BEFORE INSERT ON calendar_subscription_audit_outbox
    WHEN NEW.event_type = 'used'
    BEGIN
      SELECT RAISE(ABORT, 'forced audit outbox failure');
    END;
  `);

  let rolledBack = false;
  const cleanupFailingDatabase = {
    prepare(sql) {
      return database.prepare(sql);
    },
    exec(sql) {
      if (sql === 'ROLLBACK TO calendar_subscription_usage_state') {
        rolledBack = true;
      } else if (rolledBack && sql === 'RELEASE calendar_subscription_usage_state') {
        throw new Error('forced release cleanup failure');
      }
      return database.exec(sql);
    },
  };
  const service = createCalendarSubscriptionService({
    repository: createSqliteCalendarSubscriptionRepository(cleanupFailingDatabase),
    clock: { nowMs: () => 1_000_000 },
    randomSource: deterministicRandomSource(),
    auditSink: { record: async () => {} },
    projectAuthorization: createSqliteCalendarSubscriptionAuthorizationPort(database),
    membershipRevocation: createSqliteCalendarSubscriptionMembershipPort(database),
  });

  await assert.rejects(
    service.authorize({ secret: created.secret, projectId: '1000' }),
    /forced audit outbox failure/,
    'release cleanup failure must not replace the operation error that caused rollback',
  );
  assert.equal(rolledBack, true, 'the adapter must attempt rollback before release cleanup');
  assert.equal(
    database.prepare(
      'SELECT last_used_at_ms FROM calendar_subscriptions WHERE subscription_id = ?',
    ).get(created.subscriptionId).last_used_at_ms,
    null,
    'the causal failure must leave authorization state rolled back',
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM subscription_usage_events').get().count,
    0,
    'rollback must remove usage evidence written before the audit failure',
  );
  database.close();
});

test('savepoint rollback cleanup failure never masks the causal operation error', async () => {
  const database = new DatabaseSync(':memory:');
  installCoreSchema(database);
  installCalendarSubscriptionSchema(database);
  const created = await createSubscription(database);
  database.exec(`
    CREATE TRIGGER calendar_subscription_test_abort_usage_rollback
    BEFORE INSERT ON calendar_subscription_audit_outbox
    WHEN NEW.event_type = 'used'
    BEGIN
      SELECT RAISE(ABORT, 'forced audit outbox failure');
    END;
  `);

  let releaseAttempted = false;
  const rollbackFailingDatabase = {
    prepare(sql) {
      return database.prepare(sql);
    },
    exec(sql) {
      if (sql === 'ROLLBACK TO calendar_subscription_usage_state') {
        throw new Error('forced rollback cleanup failure');
      }
      if (sql === 'RELEASE calendar_subscription_usage_state') {
        releaseAttempted = true;
      }
      return database.exec(sql);
    },
  };
  const service = createCalendarSubscriptionService({
    repository: createSqliteCalendarSubscriptionRepository(rollbackFailingDatabase),
    clock: { nowMs: () => 1_000_000 },
    randomSource: deterministicRandomSource(),
    auditSink: { record: async () => {} },
    projectAuthorization: createSqliteCalendarSubscriptionAuthorizationPort(database),
    membershipRevocation: createSqliteCalendarSubscriptionMembershipPort(database),
  });

  await assert.rejects(
    service.authorize({ secret: created.secret, projectId: '1000' }),
    /forced audit outbox failure/,
    'rollback cleanup failure must not replace the operation error that caused rollback',
  );
  assert.equal(
    releaseAttempted,
    false,
    'an unconfirmed rollback must not release and accidentally commit the failed savepoint',
  );
  database.close();
});
