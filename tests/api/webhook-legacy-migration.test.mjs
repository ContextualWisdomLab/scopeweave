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
INSERT INTO users(id,email,password_hash,name) VALUES(1,'legacy-owner@example.test','unused','Legacy Owner');
INSERT INTO orgs(id,name,owner_id) VALUES(1,'Legacy Buyer',1);
INSERT INTO webhooks(id,org_id,url,secret,events,active)
VALUES(41,1,'http://legacy-webhook.example.test/callback','whsec_legacy','project.update',1);
`);
legacy.close();

process.env.SCOPEWEAVE_DB = databasePath;

try {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'server', 'db.mjs')).href;
  const first = await import(`${moduleUrl}?legacy-http-migration=first`);
  const migrated = first.db.prepare(
    'SELECT active, blocked_reason AS blockedReason FROM webhooks WHERE id = 41',
  ).get();
  assert.deepEqual(
    migrated,
    { active: 0, blockedReason: 'insecure_scheme' },
    'legacy HTTP webhook rows are disabled and explicitly marked instead of silently failing on every delivery',
  );

  const firstAudit = first.db.prepare(
    `SELECT action, target_type AS targetType, target_id AS targetId, meta
       FROM audit_log
      WHERE org_id = 1 AND action = 'webhook.security_block' AND target_id = '41'`,
  ).all();
  assert.equal(firstAudit.length, 1, 'migration emits one durable security audit event');
  assert.equal(firstAudit[0].targetType, 'webhook');
  assert.deepEqual(
    JSON.parse(firstAudit[0].meta),
    {
      reason: 'insecure_scheme',
      nextAction: 'register_public_https_replacement',
    },
    'audit evidence records the policy reason and remediation contract without exposing the webhook secret',
  );
  first.db.close();

  const second = await import(`${moduleUrl}?legacy-http-migration=second`);
  const secondAudit = second.db.prepare(
    `SELECT COUNT(*) AS count
       FROM audit_log
      WHERE org_id = 1 AND action = 'webhook.security_block' AND target_id = '41'`,
  ).get();
  assert.equal(secondAudit.count, 1, 'restarting after migration does not duplicate buyer audit evidence');
  assert.deepEqual(
    second.db.prepare(
      'SELECT active, blocked_reason AS blockedReason FROM webhooks WHERE id = 41',
    ).get(),
    { active: 0, blockedReason: 'insecure_scheme' },
    'migration remains fail-closed and idempotent on subsequent starts',
  );
  second.db.close();
} finally {
  delete process.env.SCOPEWEAVE_DB;
  rmSync(directory, { recursive: true, force: true });
}

console.log('legacy HTTP webhook migration regression passed');
