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
    INSERT INTO users(id, token_version) VALUES (1, 0);
    INSERT INTO orgs(id) VALUES (10);
    INSERT INTO memberships(id, org_id, user_id) VALUES (100, 10, 1);
    INSERT INTO projects(id, org_id) VALUES (1000, 10);
    INSERT INTO attachments(id, project_id, status) VALUES (5000, 1000, 'SUCCEEDED');
  `);
  installAccessGrantSchema(db);
  return db;
}

function createService(db) {
  let randomValue = 1;
  return createAccessGrantService({
    repository: createSqliteAccessGrantRepository(db),
    clock: { nowMs: () => 25_000 },
    randomSource: {
      randomBytes(length) {
        randomValue += 1;
        return new Uint8Array(length).fill(randomValue);
      },
    },
    auditSink: { record: async () => {} },
    projectAuthorization: createSqliteAccessGrantAuthorizationPort(db),
    membershipRevocation: createSqliteAccessGrantMembershipPort(db),
  });
}

const mintRequest = {
  subjectId: '1',
  projectId: '1000',
  purpose: ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW,
  audience: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
  attachmentId: '5000',
  ttlSeconds: 60,
};

const redeemRequest = (secret) => ({
  secret,
  purpose: ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW,
  audience: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
  projectId: '1000',
  attachmentId: '5000',
});

test('mint and consume persist secret-free audit evidence transactionally', async () => {
  const db = fixture();
  const service = createService(db);

  const minted = await service.mint(mintRequest);
  await service.redeem(redeemRequest(minted.secret));

  const events = db.prepare(`
    SELECT event_type, grant_id, subject_id, project_id, purpose, audience,
           attachment_id, occurred_at_ms, delivered_at_ms
      FROM access_grant_audit_outbox
     ORDER BY event_id
  `).all();
  assert.deepEqual(
    events.map(({ event_type }) => event_type),
    ['minted', 'consumed'],
    'both security-relevant grant transitions have durable evidence',
  );
  assert.ok(events.every(({ grant_id }) => grant_id === minted.grantId));
  assert.ok(events.every(({ subject_id }) => subject_id === 1));
  assert.ok(events.every(({ project_id }) => project_id === 1000));
  assert.ok(events.every(({ attachment_id }) => attachment_id === 5000));
  assert.ok(events.every(({ purpose }) => purpose === ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW));
  assert.ok(events.every(({ audience }) => audience === ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW));
  assert.ok(events.every(({ occurred_at_ms }) => occurred_at_ms === 25_000));
  assert.ok(events.every(({ delivered_at_ms }) => delivered_at_ms === null));
  assert.equal(
    JSON.stringify(events).includes(minted.secret),
    false,
    'the plaintext grant secret never enters durable audit evidence',
  );
  db.close();
});

test('mint fails without persisting a usable grant when durable audit evidence cannot commit', async () => {
  const db = fixture();
  const service = createService(db);
  db.exec(`
    CREATE TRIGGER access_grant_audit_reject_mint_trigger
    BEFORE INSERT ON access_grant_audit_outbox
    WHEN NEW.event_type = 'minted'
    BEGIN
      SELECT RAISE(ABORT, 'audit outbox unavailable');
    END;
  `);

  await assert.rejects(service.mint(mintRequest), /audit outbox unavailable/);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM access_grants').get().count,
    0,
    'grant insert rolls back when its durable audit event cannot be recorded',
  );
  db.close();
});

test('consume rolls back one-time state when durable consume evidence cannot commit', async () => {
  const db = fixture();
  const service = createService(db);
  const minted = await service.mint(mintRequest);
  db.exec(`
    CREATE TRIGGER access_grant_audit_reject_consume_trigger
    BEFORE INSERT ON access_grant_audit_outbox
    WHEN NEW.event_type = 'consumed'
    BEGIN
      SELECT RAISE(ABORT, 'audit outbox unavailable');
    END;
  `);

  await assert.rejects(service.redeem(redeemRequest(minted.secret)), /audit outbox unavailable/);
  assert.equal(
    db.prepare('SELECT used_at_ms FROM access_grants WHERE grant_id = ?').get(minted.grantId).used_at_ms,
    null,
    'failed durable consume evidence leaves the one-time grant unused and safely retryable',
  );

  db.exec('DROP TRIGGER access_grant_audit_reject_consume_trigger');
  const redeemed = await service.redeem(redeemRequest(minted.secret));
  assert.equal(redeemed.grantId, minted.grantId, 'the same grant may be consumed after the durable boundary recovers');
  db.close();
});

test('audit evidence survives attachment deletion while the usable grant is revoked', async () => {
  const db = fixture();
  const service = createService(db);
  const minted = await service.mint(mintRequest);

  db.prepare('DELETE FROM attachments WHERE id = 5000').run();
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM access_grants WHERE grant_id = ?').get(minted.grantId).count,
    0,
    'attachment deletion revokes the outstanding usable grant',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM access_grant_audit_outbox WHERE grant_id = ?').get(minted.grantId).count,
    1,
    'immutable mint evidence is retained after resource lifecycle deletion',
  );
  db.close();
});
