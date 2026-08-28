import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  ACCESS_GRANT_AUDIENCES,
  ACCESS_GRANT_PURPOSES,
  createAccessGrantService,
} from '../../server/access_grant_domain.mjs';
import {
  createSqliteAccessGrantAuthorizationPort,
  createSqliteAccessGrantMembershipPort,
  createSqliteAccessGrantRepository,
  installAccessGrantSchema,
} from '../../server/access_grant_sqlite.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, token_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE orgs (id INTEGER PRIMARY KEY);
    CREATE TABLE memberships (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      UNIQUE(org_id, user_id)
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE
    );
    CREATE TABLE attachments (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL
    );
    INSERT INTO users(id, token_version) VALUES (1, 0), (2, 0);
    INSERT INTO orgs(id) VALUES (10), (20);
    INSERT INTO memberships(id, org_id, user_id) VALUES (100, 10, 1), (200, 20, 2);
    INSERT INTO projects(id, org_id) VALUES (1000, 10), (2000, 20);
    INSERT INTO attachments(id, project_id, status) VALUES (5000, 1000, 'SUCCEEDED');
  `);
  installAccessGrantSchema(db);
  return db;
}

function cleanupFaultDatabase(database, { failRollback = false, failRelease = false } = {}) {
  let rollbackAttempted = false;
  const commands = [];
  return {
    commands,
    prepare: database.prepare.bind(database),
    exec(sql) {
      commands.push(sql);
      if (sql.startsWith('ROLLBACK TO ')) {
        rollbackAttempted = true;
        if (failRollback) throw new Error('simulated_rollback_cleanup_failure');
      }
      if (rollbackAttempted && sql.startsWith('RELEASE ') && failRelease) {
        throw new Error('simulated_release_cleanup_failure');
      }
      return database.exec(sql);
    },
  };
}

function deterministicRandom() {
  let value = 9;
  return {
    randomBytes(length) {
      value += 1;
      return new Uint8Array(length).fill(value);
    },
  };
}

function createService(db, nowMs = 5_000) {
  return createAccessGrantService({
    repository: createSqliteAccessGrantRepository(db),
    clock: { nowMs: typeof nowMs === 'function' ? nowMs : () => nowMs },
    randomSource: deterministicRandom(),
    auditSink: { record: async () => {} },
    projectAuthorization: createSqliteAccessGrantAuthorizationPort(db),
    membershipRevocation: createSqliteAccessGrantMembershipPort(db),
  });
}

test('adapter factories reject missing database capabilities and schema install is idempotent', () => {
  assert.throws(() => installAccessGrantSchema(), /requires a database/);
  assert.throws(() => createSqliteAccessGrantRepository({ exec() {} }), /requires a database/);
  assert.throws(() => createSqliteAccessGrantAuthorizationPort({ prepare() {} }), /requires a database/);
  assert.throws(() => createSqliteAccessGrantMembershipPort(null), /requires a database/);

  const db = fixture();
  assert.doesNotThrow(() => installAccessGrantSchema(db), 'bootstrap may be repeated safely');
  db.close();
});

test('access-grant schema avoids redundant write-only indexes', () => {
  const db = fixture();
  const indexes = db.prepare("PRAGMA index_list('access_grants')").all();
  assert.deepEqual(
    indexes.filter((index) => index.origin === 'c').map((index) => index.name).sort(),
    [],
    'access_grants should rely on constraint-owned indexes instead of duplicate or unused explicit indexes',
  );
  assert.equal(
    indexes.some((index) => index.origin === 'u' && index.unique === 1),
    true,
    'token_hash UNIQUE must continue to provide SQLite-enforced lookup uniqueness',
  );
  db.close();
});

test('repository returns null for unknown hashes and rejects a mismatched binding without consuming', async () => {
  const db = fixture();
  const repository = createSqliteAccessGrantRepository(db);
  assert.equal(await repository.findGrantByHash('0'.repeat(64)), null);

  const service = createService(db);
  const minted = await service.mint({
    subjectId: '1',
    projectId: '1000',
    purpose: ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW,
    audience: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
    attachmentId: '5000',
    ttlSeconds: 60,
  });

  await assert.rejects(
    service.redeem({
      secret: minted.secret,
      purpose: ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW,
      audience: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
      projectId: '1000',
      attachmentId: '5001',
    }),
    (error) => error?.code === 'access_grant_unauthorized',
  );
  assert.equal(
    db.prepare('SELECT used_at_ms FROM access_grants WHERE grant_id = ?').get(minted.grantId).used_at_ms,
    null,
    'wrong resource binding does not burn the correct grant',
  );
  db.close();
});

test('backward clock rejects a grant without leaking a SQLite constraint error or consuming it', async () => {
  const db = fixture();
  let nowMs = 5_000;
  const service = createService(db, () => nowMs);
  const minted = await service.mint({
    subjectId: '1',
    projectId: '1000',
    purpose: ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW,
    audience: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
    attachmentId: '5000',
    ttlSeconds: 60,
  });

  nowMs = 4_999;
  await assert.rejects(
    service.redeem({
      secret: minted.secret,
      purpose: ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW,
      audience: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
      projectId: '1000',
      attachmentId: '5000',
    }),
    (error) => error?.code === 'access_grant_unauthorized' && error?.status === 401,
    'clock rollback fails through the same opaque unauthorized boundary as other invalid grants',
  );
  assert.equal(
    db.prepare('SELECT used_at_ms FROM access_grants WHERE grant_id = ?').get(minted.grantId).used_at_ms,
    null,
    'clock rollback does not consume the one-time grant',
  );
  db.close();
});

test('membership disappearing between authorization and persistence stays in the opaque mint boundary', async () => {
  const db = fixture();
  const authorization = createSqliteAccessGrantAuthorizationPort(db);
  const service = createAccessGrantService({
    repository: createSqliteAccessGrantRepository(db),
    clock: { nowMs: () => 5_000 },
    randomSource: deterministicRandom(),
    auditSink: { record: async () => {} },
    projectAuthorization: {
      async assertCanIssue(input) {
        await authorization.assertCanIssue(input);
        db.prepare('DELETE FROM memberships WHERE org_id = ? AND user_id = ?').run(10, 1);
      },
    },
    membershipRevocation: createSqliteAccessGrantMembershipPort(db),
  });

  await assert.rejects(
    service.mint({
      subjectId: '1',
      projectId: '1000',
      purpose: ACCESS_GRANT_PURPOSES.STREAM,
      audience: ACCESS_GRANT_AUDIENCES.STREAM,
      ttlSeconds: 15,
    }),
    (error) => error?.code === 'access_grant_not_authorized' && error?.status === 404,
    'a lost membership maps to the same nondisclosing mint response as an authorization miss',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM access_grants').get().count,
    0,
    'a rejected persistence race leaves no usable grant',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM access_grant_audit_outbox').get().count,
    0,
    'a rejected persistence race leaves no mint evidence',
  );
  db.close();
});

test('stream grants exercise null-resource persistence and project-only authorization', async () => {
  const db = fixture();
  const service = createService(db);
  const minted = await service.mint({
    subjectId: '1',
    projectId: '1000',
    purpose: ACCESS_GRANT_PURPOSES.STREAM,
    audience: ACCESS_GRANT_AUDIENCES.STREAM,
    ttlSeconds: 15,
  });
  const stored = db.prepare('SELECT attachment_id FROM access_grants WHERE grant_id = ?').get(minted.grantId);
  assert.equal(stored.attachment_id, null);

  const redeemed = await service.redeem({
    secret: minted.secret,
    purpose: ACCESS_GRANT_PURPOSES.STREAM,
    audience: ACCESS_GRANT_AUDIENCES.STREAM,
    projectId: '1000',
  });
  assert.equal(redeemed.attachmentId, null);

  await assert.rejects(
    service.mint({
      subjectId: '1',
      projectId: '2000',
      purpose: ACCESS_GRANT_PURPOSES.STREAM,
      audience: ACCESS_GRANT_AUDIENCES.STREAM,
      ttlSeconds: 15,
    }),
    (error) => error?.code === 'access_grant_not_authorized',
    'project-only authorization still enforces tenant membership',
  );
  db.close();
});

test('membership port fails closed after membership removal', async () => {
  const db = fixture();
  const membership = createSqliteAccessGrantMembershipPort(db);
  assert.equal(await membership.assertActive({ subjectId: '1', projectId: '1000' }), '100:0');
  db.prepare('DELETE FROM memberships WHERE id = 100').run();
  await assert.rejects(
    membership.assertActive({ subjectId: '1', projectId: '1000' }),
    /membership_inactive/,
  );
  db.close();
});

test('database constraints reject impossible grant lifetimes', async () => {
  const db = fixture();
  const repository = createSqliteAccessGrantRepository(db);
  await assert.rejects(
    repository.insertGrant({
      grant_id: 'agr_invalid',
      token_hash: '1'.repeat(64),
      subject_id: '1',
      project_id: '1000',
      purpose: ACCESS_GRANT_PURPOSES.STREAM,
      audience: ACCESS_GRANT_AUDIENCES.STREAM,
      attachment_id: null,
      issued_at_ms: 10,
      expires_at_ms: 10,
      used_at_ms: null,
      revoked_at_ms: null,
    }),
    /CHECK constraint failed/,
  );
  db.close();
});

test('savepoint cleanup failures never replace the causal persistence error', async () => {
  const record = {
    grant_id: 'agr_cleanup_failure',
    token_hash: '2'.repeat(64),
    subject_id: '1',
    project_id: '1000',
    purpose: ACCESS_GRANT_PURPOSES.STREAM,
    audience: ACCESS_GRANT_AUDIENCES.STREAM,
    attachment_id: null,
    issued_at_ms: 10,
    expires_at_ms: 10,
    used_at_ms: null,
    revoked_at_ms: null,
  };

  for (const faults of [
    { failRollback: true, failRelease: false },
    { failRollback: false, failRelease: true },
  ]) {
    const db = fixture();
    const faultDb = cleanupFaultDatabase(db, faults);
    const repository = createSqliteAccessGrantRepository(faultDb);

    await assert.rejects(
      repository.insertGrant(record),
      (error) => /CHECK constraint failed/.test(error?.message ?? ''),
      'cleanup failures must not mask the operation failure',
    );

    if (faults.failRollback) {
      assert.equal(
        faultDb.commands.some((sql) => sql.startsWith('RELEASE access_grant_insert_state')),
        false,
        'a failed rollback must not release the failed savepoint',
      );
      assert.equal(
        faultDb.commands.some((sql) => sql === 'ROLLBACK'),
        true,
        'a failed savepoint rollback must abort the shared transaction',
      );
    }
    db.close();
  }
});
