import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

function installCoreSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
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
    CREATE TABLE attachments (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL
    );
  `);
}

function seed(db) {
  db.exec(`
    INSERT INTO users(id, token_version) VALUES (1, 0), (2, 0);
    INSERT INTO orgs(id) VALUES (10), (20);
    INSERT INTO memberships(id, org_id, user_id) VALUES (100, 10, 1), (200, 20, 2);
    INSERT INTO projects(id, org_id) VALUES (1000, 10), (2000, 20);
    INSERT INTO attachments(id, project_id, status)
      VALUES (5000, 1000, 'SUCCEEDED'), (5001, 1000, 'PENDING'), (6000, 2000, 'SUCCEEDED');
  `);
}

function randomSource() {
  let call = 0;
  return {
    randomBytes(length) {
      call += 1;
      return new Uint8Array(length).fill(call);
    },
  };
}

function serviceFor(db, nowMs = 1_000_000) {
  installAccessGrantSchema(db);
  const auditEvents = [];
  const service = createAccessGrantService({
    repository: createSqliteAccessGrantRepository(db),
    clock: { nowMs: () => nowMs },
    randomSource: randomSource(),
    auditSink: { record: async (event) => auditEvents.push(event) },
    projectAuthorization: createSqliteAccessGrantAuthorizationPort(db),
    membershipRevocation: createSqliteAccessGrantMembershipPort(db),
  });
  return { service, auditEvents };
}

const attachmentRequest = (attachmentId = '5000') => ({
  subjectId: '1',
  projectId: '1000',
  purpose: ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW,
  audience: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
  attachmentId,
  ttlSeconds: 60,
});

const redeemRequest = (secret, attachmentId = '5000') => ({
  secret,
  purpose: ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW,
  audience: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
  projectId: '1000',
  attachmentId,
});

test('SQLite adapter persists only a hash and consumes one attachment grant once', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const { service, auditEvents } = serviceFor(db);

  const minted = await service.mint(attachmentRequest());
  const stored = db.prepare('SELECT * FROM access_grants WHERE grant_id = ?').get(minted.grantId);
  assert.ok(stored, 'grant is persisted');
  assert.equal(stored.subject_id, 1);
  assert.equal(stored.project_id, 1000);
  assert.equal(stored.attachment_id, 5000);
  assert.notEqual(stored.token_hash, minted.secret);
  assert.equal(stored.token_hash.length, 64, 'SHA-256 hash is persisted');
  assert.equal(Object.hasOwn(stored, 'secret'), false, 'plaintext secret is not a schema field');

  const redeemed = await service.redeem(redeemRequest(minted.secret));
  assert.equal(redeemed.subjectId, '1');
  assert.equal(redeemed.projectId, '1000');
  assert.equal(redeemed.attachmentId, '5000');
  assert.equal(auditEvents.length, 2);
  assert.ok(auditEvents.every((event) => !JSON.stringify(event).includes(minted.secret)));

  await assert.rejects(
    service.redeem(redeemRequest(minted.secret)),
    (error) => error?.code === 'access_grant_unauthorized' && error?.status === 401,
    'replay fails closed',
  );
  db.close();
});

test('SQLite adapter atomically binds membership version to redemption', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const { service } = serviceFor(db);

  const tokenVersionGrant = await service.mint(attachmentRequest());
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = 1').run();
  await assert.rejects(
    service.redeem(redeemRequest(tokenVersionGrant.secret)),
    (error) => error?.code === 'access_grant_unauthorized',
    'logout-all/password-style token-version changes invalidate an unconsumed grant',
  );

  db.prepare('UPDATE users SET token_version = 0 WHERE id = 1').run();
  const membershipGrant = await service.mint(attachmentRequest());
  db.prepare('DELETE FROM memberships WHERE id = 100').run();
  db.prepare('INSERT INTO memberships(id, org_id, user_id) VALUES (101, 10, 1)').run();
  await assert.rejects(
    service.redeem(redeemRequest(membershipGrant.secret)),
    (error) => error?.code === 'access_grant_unauthorized',
    'remove/re-add changes membership identity and invalidates the captured membership version',
  );
  db.close();
});

test('authorization is tenant-nondisclosing and requires a ready bound attachment', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const { service } = serviceFor(db);

  await assert.rejects(
    service.mint(attachmentRequest('6000')),
    (error) => error?.code === 'access_grant_not_authorized' && error?.status === 404,
    'another tenant attachment is indistinguishable from an absent resource',
  );
  await assert.rejects(
    service.mint(attachmentRequest('5001')),
    (error) => error?.code === 'access_grant_not_authorized' && error?.status === 404,
    'an attachment not ready for viewing cannot receive a view grant',
  );
  db.close();
});

test('attachment deletion cascades outstanding grants and schema objects follow naming contract', async () => {
  const db = new DatabaseSync(':memory:');
  installCoreSchema(db);
  seed(db);
  const { service } = serviceFor(db);
  const minted = await service.mint(attachmentRequest());

  db.prepare('DELETE FROM attachments WHERE id = 5000').run();
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM access_grants WHERE grant_id = ?').get(minted.grantId).count,
    0,
    'resource deletion revokes outstanding grants through the foreign-key lifecycle',
  );

  const objects = db.prepare(`
    SELECT name, type FROM sqlite_master
    WHERE name IN ('access_grants', 'access_grant_audit_outbox')
       OR name LIKE 'access_grant_%_index'
    ORDER BY name
  `).all();
  assert.deepEqual(
    objects.map(({ name }) => name),
    [
      'access_grant_audit_delivery_index',
      'access_grant_audit_outbox',
      'access_grant_subject_resource_index',
      'access_grant_token_hash_index',
      'access_grants',
    ],
  );
  assert.ok(objects.every(({ name }) => name.includes('_')), 'owned DB object names contain multiple lexical words');
  db.close();
});

test('grant state survives process-style SQLite reopen and remains redeemable exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scopeweave-access-grant-'));
  const file = join(dir, 'grants.sqlite');
  try {
    let db = new DatabaseSync(file);
    installCoreSchema(db);
    seed(db);
    const first = serviceFor(db);
    const minted = await first.service.mint(attachmentRequest());
    db.close();

    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = ON');
    const second = serviceFor(db);
    const redeemed = await second.service.redeem(redeemRequest(minted.secret));
    assert.equal(redeemed.grantId, minted.grantId);
    await assert.rejects(second.service.redeem(redeemRequest(minted.secret)));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
