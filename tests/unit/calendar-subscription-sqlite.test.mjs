import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createCalendarSubscriptionService,
} from '../../server/calendar_subscription_domain.mjs';
import {
  createSqliteCalendarSubscriptionAuthorizationPort,
  createSqliteCalendarSubscriptionMembershipPort,
  createSqliteCalendarSubscriptionRepository,
  installCalendarSubscriptionSchema,
} from '../../server/calendar_subscription_sqlite.mjs';

function installCoreSchema(db) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
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
  `);
}

function seed(db) {
  db.exec(`
    INSERT INTO users(id, token_version) VALUES (1, 0), (2, 0);
    INSERT INTO orgs(id) VALUES (10), (20);
    INSERT INTO memberships(id, org_id, user_id) VALUES (100, 10, 1), (200, 20, 2);
    INSERT INTO projects(id, org_id) VALUES (1000, 10), (2000, 20);
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

function mutableClock(initial = 1_000_000) {
  return {
    value: initial,
    nowMs() {
      return this.value;
    },
  };
}

function serviceFor(db, clock = mutableClock()) {
  installCalendarSubscriptionSchema(db);
  const auditEvents = [];
  const service = createCalendarSubscriptionService({
    repository: createSqliteCalendarSubscriptionRepository(db),
    clock,
    randomSource: deterministicRandomSource(),
    auditSink: { record: async (event) => auditEvents.push(event) },
    projectAuthorization: createSqliteCalendarSubscriptionAuthorizationPort(db),
    membershipRevocation: createSqliteCalendarSubscriptionMembershipPort(db),
  });
  return { service, auditEvents, clock };
}

const createRequest = (overrides = {}) => ({
  subjectId: '1',
  projectId: '1000',
  name: 'Primary calendar',
  expiresAtMs: 2_000_000,
  ...overrides,
});

function secretHash(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

test('SQLite calendar adapter persists hash-only reusable state and safe list metadata', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const { service } = serviceFor(db);

  const created = await service.create(createRequest());
  assert.equal(created.secret.length, 43);
  const stored = db.prepare('SELECT * FROM calendar_subscriptions WHERE subscription_id = ?').get(created.subscriptionId);
  assert.ok(stored);
  assert.equal(stored.subject_id, 1);
  assert.equal(stored.project_id, 1000);
  assert.equal(stored.membership_version, '100:0');
  assert.equal(stored.purpose, 'calendar_read');
  assert.equal(stored.secret_hash, secretHash(created.secret));
  assert.notEqual(stored.secret_hash, created.secret);
  assert.equal(Object.hasOwn(stored, 'secret'), false);

  const listed = await service.list({ subjectId: '1', projectId: '1000' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].subscriptionId, created.subscriptionId);
  assert.equal(listed[0].status, 'active');
  assert.equal(Object.hasOwn(listed[0], 'secret'), false);
  assert.equal(Object.hasOwn(listed[0], 'secret_hash'), false);
  assert.equal(Object.hasOwn(listed[0], 'membership_version'), false);

  const outbox = db.prepare('SELECT * FROM calendar_subscription_audit_outbox ORDER BY audit_event_id').all();
  assert.deepEqual(outbox.map(({ event_type }) => event_type), ['created']);
  assert.ok(outbox.every((row) => !JSON.stringify(row).includes(created.secret)));
  db.close();
});

test('calendar secret is reusable only for its project, live membership, and pre-expiry window', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const clock = mutableClock();
  const { service } = serviceFor(db, clock);
  const created = await service.create(createRequest());

  await assert.rejects(
    service.authorize({ secret: created.secret, projectId: '2000' }),
    (error) => error?.code === 'calendar_subscription_unauthorized' && error?.status === 401,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subscription_usage_events').get().count, 0);

  const first = await service.authorize({ secret: created.secret, projectId: '1000' });
  assert.equal(first.subscriptionId, created.subscriptionId);
  clock.value += 1_000;
  await service.authorize({ secret: created.secret, projectId: '1000' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subscription_usage_events').get().count, 2);
  assert.equal(
    db.prepare('SELECT last_used_at_ms FROM calendar_subscriptions WHERE subscription_id = ?').get(created.subscriptionId).last_used_at_ms,
    clock.value,
  );

  clock.value = 2_000_000;
  await assert.rejects(
    service.authorize({ secret: created.secret, projectId: '1000' }),
    (error) => error?.code === 'calendar_subscription_unauthorized',
    'exact expiry is not usable',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subscription_usage_events').get().count, 2);
  db.close();
});

test('membership revocation invalidates use while authenticated rotation snapshots the new version', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const clock = mutableClock();
  const { service } = serviceFor(db, clock);
  const created = await service.create(createRequest());

  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = 1').run();
  await assert.rejects(
    service.authorize({ secret: created.secret, projectId: '1000' }),
    (error) => error?.code === 'calendar_subscription_unauthorized',
    'session-version change makes the stored subscription unusable',
  );

  clock.value += 100;
  const rotated = await service.rotate({
    subjectId: '1',
    projectId: '1000',
    subscriptionId: created.subscriptionId,
    expiresAtMs: 2_100_000,
  });
  assert.notEqual(rotated.secret, created.secret);
  assert.equal(
    db.prepare('SELECT membership_version FROM calendar_subscriptions WHERE subscription_id = ?').get(created.subscriptionId).membership_version,
    '100:1',
    'rotation snapshots the independently rechecked live membership version',
  );
  await assert.rejects(service.authorize({ secret: created.secret, projectId: '1000' }));
  await service.authorize({ secret: rotated.secret, projectId: '1000' });

  db.prepare('DELETE FROM memberships WHERE id = 100').run();
  db.prepare('INSERT INTO memberships(id, org_id, user_id) VALUES (101, 10, 1)').run();
  await assert.rejects(
    service.authorize({ secret: rotated.secret, projectId: '1000' }),
    (error) => error?.code === 'calendar_subscription_unauthorized',
    'membership remove/re-add changes the durable authorization version',
  );
  db.close();
});

test('rotation invalidates the old hash without retaining credential material in history relations', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const clock = mutableClock();
  const { service } = serviceFor(db, clock);
  const created = await service.create(createRequest());
  const oldHash = secretHash(created.secret);

  clock.value += 500;
  const rotated = await service.rotate({
    subjectId: '1',
    projectId: '1000',
    subscriptionId: created.subscriptionId,
    expiresAtMs: 2_500_000,
  });
  const current = db.prepare('SELECT secret_hash, rotated_at_ms FROM calendar_subscriptions WHERE subscription_id = ?').get(created.subscriptionId);
  assert.equal(current.secret_hash, secretHash(rotated.secret));
  assert.notEqual(current.secret_hash, oldHash);
  assert.equal(current.rotated_at_ms, clock.value);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_subscriptions WHERE secret_hash = ?').get(oldHash).count, 0);

  const rotationColumns = db.prepare('PRAGMA table_info(subscription_rotations)').all().map(({ name }) => name);
  const usageColumns = db.prepare('PRAGMA table_info(subscription_usage_events)').all().map(({ name }) => name);
  const outboxColumns = db.prepare('PRAGMA table_info(calendar_subscription_audit_outbox)').all().map(({ name }) => name);
  for (const columns of [rotationColumns, usageColumns, outboxColumns]) {
    assert.equal(columns.some((name) => /secret|hash/i.test(name)), false, 'history/audit relations retain no credential material');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subscription_rotations').get().count, 1);
  db.close();
});

test('revocation is idempotent, auditable once, and blocks subsequent use', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const clock = mutableClock();
  const { service } = serviceFor(db, clock);
  const created = await service.create(createRequest());

  clock.value += 700;
  const first = await service.revoke({ subjectId: '1', projectId: '1000', subscriptionId: created.subscriptionId });
  const second = await service.revoke({ subjectId: '1', projectId: '1000', subscriptionId: created.subscriptionId });
  assert.equal(first.status, 'revoked');
  assert.equal(second.revokedAtMs, first.revokedAtMs);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM calendar_subscription_audit_outbox WHERE event_type = 'revoked'").get().count,
    1,
  );
  await assert.rejects(
    service.authorize({ secret: created.secret, projectId: '1000' }),
    (error) => error?.code === 'calendar_subscription_unauthorized',
  );
  db.close();
});

test('tenant management is nondisclosing and cannot list or mutate another organization subscription', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const { service } = serviceFor(db);
  const created = await service.create(createRequest());

  await assert.rejects(
    service.list({ subjectId: '2', projectId: '1000' }),
    (error) => error?.code === 'calendar_subscription_not_found' && error?.status === 404,
  );
  await assert.rejects(
    service.rotate({
      subjectId: '2',
      projectId: '1000',
      subscriptionId: created.subscriptionId,
      expiresAtMs: 2_500_000,
    }),
    (error) => error?.code === 'calendar_subscription_not_found',
  );
  db.close();
});

test('state survives process-style reopen and remains usable until explicit revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scopeweave-calendar-subscription-'));
  const file = join(dir, 'calendar.sqlite');
  try {
    let db = new DatabaseSync(file);
    installCoreSchema(db);
    seed(db);
    const first = serviceFor(db);
    const created = await first.service.create(createRequest());
    db.close();

    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = ON');
    const second = serviceFor(db);
    const authorized = await second.service.authorize({ secret: created.secret, projectId: '1000' });
    assert.equal(authorized.subscriptionId, created.subscriptionId);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repository rolls back usage state and immutable evidence together on audit-outbox failure', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const { service } = serviceFor(db);
  const created = await service.create(createRequest());
  db.exec(`
    CREATE TRIGGER calendar_subscription_test_abort_usage
    BEFORE INSERT ON calendar_subscription_audit_outbox
    WHEN NEW.event_type = 'used'
    BEGIN
      SELECT RAISE(ABORT, 'forced audit outbox failure');
    END;
  `);

  await assert.rejects(service.authorize({ secret: created.secret, projectId: '1000' }), /forced audit outbox failure/);
  const row = db.prepare('SELECT last_used_at_ms FROM calendar_subscriptions WHERE subscription_id = ?').get(created.subscriptionId);
  assert.equal(row.last_used_at_ms, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM subscription_usage_events').get().count, 0);
  db.close();
});

test('owned schema is normalized, uses descriptive multiword names, and passes foreign-key integrity', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  installCalendarSubscriptionSchema(db);

  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => db.prepare(`
    INSERT INTO calendar_subscriptions(
      subscription_id, secret_hash, subject_id, project_id, name, purpose, audience,
      membership_version, created_at_ms, expires_at_ms, last_used_at_ms,
      rotated_at_ms, revoked_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
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
  ), /FOREIGN KEY constraint failed/);

  const owned = db.prepare(`
    SELECT name, type
      FROM sqlite_master
     WHERE name LIKE 'calendar_subscription%'
        OR name LIKE 'subscription_rotation%'
        OR name LIKE 'subscription_usage%'
     ORDER BY name
  `).all();
  assert.deepEqual(
    owned.map(({ name }) => name),
    [
      'calendar_subscription_audit_delivery_index',
      'calendar_subscription_audit_outbox',
      'calendar_subscription_secret_hash_index',
      'calendar_subscription_subject_project_index',
      'calendar_subscriptions',
      'subscription_rotation_history_index',
      'subscription_rotations',
      'subscription_usage_events',
      'subscription_usage_history_index',
    ],
  );
  assert.ok(owned.every(({ name }) => name.includes('_')), 'every owned SQLite object uses multiple lexical words');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const rotations = db.prepare('PRAGMA table_info(subscription_rotations)').all().map(({ name }) => name);
  assert.deepEqual(rotations, ['rotation_event_id', 'subscription_id', 'rotated_at_ms', 'expires_at_ms']);
  const usage = db.prepare('PRAGMA table_info(subscription_usage_events)').all().map(({ name }) => name);
  assert.deepEqual(usage, ['usage_event_id', 'subscription_id', 'used_at_ms']);
  db.close();
});

test('adapter dependencies and stale or missing atomic transitions fail closed', async () => {
  assert.throws(
    () => installCalendarSubscriptionSchema(null),
    /requires a database with exec\(\) and prepare\(\)/,
  );

  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  installCalendarSubscriptionSchema(db);
  const repository = createSqliteCalendarSubscriptionRepository(db);

  db.prepare('UPDATE users SET token_version = 1 WHERE id = 1').run();
  await assert.rejects(
    repository.insertSubscription({
      subscription_id: 'csub_stale_membership_snapshot',
      secret_hash: 'a'.repeat(64),
      subject_id: '1',
      project_id: '1000',
      name: 'Stale membership attempt',
      audience: 'scopeweave:calendar',
      membership_version: '100:0',
      created_at_ms: 1_000_000,
      expires_at_ms: 2_000_000,
      last_used_at_ms: null,
      rotated_at_ms: null,
      revoked_at_ms: null,
    }),
    /calendar_subscription_membership_inactive/,
    'create must recheck the live membership version inside the persistence boundary',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_subscriptions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_subscription_audit_outbox').get().count, 0);

  const missingRotation = await repository.rotateSubscriptionAtomically('csub_missing', {
    subject_id: '1',
    project_id: '1000',
    new_secret_hash: 'b'.repeat(64),
    now_ms: 1_000_100,
    expires_at_ms: 2_000_000,
    membership_version: '100:1',
  });
  assert.equal(missingRotation, null);

  const missingRevocation = await repository.revokeSubscriptionAtomically('csub_missing', {
    subject_id: '1',
    project_id: '1000',
    now_ms: 1_000_100,
  });
  assert.equal(missingRevocation, null);
  assert.equal(await repository.findSubscriptionByHash('f'.repeat(64)), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_subscription_audit_outbox').get().count, 0);
  db.close();
});