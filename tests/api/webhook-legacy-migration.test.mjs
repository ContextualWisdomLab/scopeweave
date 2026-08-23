import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const directory = mkdtempSync(join(tmpdir(), 'scopeweave-webhook-migration-'));
const databasePath = join(directory, 'legacy.sqlite');
const legacy = new DatabaseSync(databasePath);
legacy.exec(`
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE orgs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '*',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO users(id,email,password_hash,name)
VALUES(1,'legacy-owner@example.test','unused','Legacy Owner');
INSERT INTO orgs(id,name,owner_id) VALUES(1,'Legacy Buyer',1);
INSERT INTO webhooks(id,org_id,url,secret,events,active) VALUES
  (41,1,'http://legacy-webhook.example.test/callback','whsec_legacy_active','project.update',1),
  (42,1,'https://webhook.example.test/callback','whsec_public_https','project.update',1),
  (43,1,'http://retired-webhook.example.test/callback','whsec_legacy_inactive','project.update',0);
`);
legacy.close();

process.env.SCOPEWEAVE_DB = databasePath;

try {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'server', 'db.mjs')).href;
  const first = await import(`${moduleUrl}?legacy-http-migration=first`);

  assert.deepEqual(
    first.db.prepare('SELECT id, active FROM webhooks ORDER BY id').all(),
    [
      { id: 41, active: 0 },
      { id: 42, active: 1 },
      { id: 43, active: 0 },
    ],
    'startup disables only previously active insecure HTTP webhooks and preserves HTTPS/inactive rows',
  );

  const firstAudit = first.db.prepare(
    `SELECT action, target_type AS targetType, target_id AS targetId, meta
       FROM audit_log
      WHERE org_id = 1 AND action = 'webhook.security_block'
      ORDER BY id`,
  ).all();
  assert.equal(firstAudit.length, 1, 'migration emits one durable buyer-visible security audit event');
  assert.equal(firstAudit[0].targetType, 'webhook');
  assert.equal(firstAudit[0].targetId, '41');
  assert.deepEqual(
    JSON.parse(firstAudit[0].meta),
    {
      reason: 'insecure_scheme',
      nextAction: 'register_public_https_replacement',
    },
    'audit evidence gives the operator a concrete remediation action',
  );
  assert.equal(
    firstAudit[0].meta.includes('whsec_'),
    false,
    'buyer-visible audit evidence never includes the webhook signing secret',
  );
  first.db.close();

  const second = await import(`${moduleUrl}?legacy-http-migration=second`);
  assert.equal(
    second.db.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_log
        WHERE org_id = 1 AND action = 'webhook.security_block' AND target_id = '41'`,
    ).get().count,
    1,
    'restart is idempotent and does not duplicate the security audit event',
  );
  assert.equal(
    second.db.prepare('SELECT active FROM webhooks WHERE id = 41').get().active,
    0,
    'restart remains fail-closed for the migrated insecure destination',
  );
  second.db.close();
} finally {
  delete process.env.SCOPEWEAVE_DB;
  rmSync(directory, { recursive: true, force: true });
}

console.log('legacy HTTP webhook migration regression passed');
