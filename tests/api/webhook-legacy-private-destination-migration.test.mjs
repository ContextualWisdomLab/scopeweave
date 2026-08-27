import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const directory = mkdtempSync(join(tmpdir(), 'scopeweave-webhook-private-migration-'));
const databasePath = join(directory, 'legacy-private.sqlite');
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
INSERT INTO users(id,email,password_hash,name)
VALUES(1,'legacy-owner@example.test','unused','Legacy Owner');
INSERT INTO orgs(id,name,owner_id) VALUES(1,'Legacy Buyer',1);
INSERT INTO webhooks(id,org_id,url,secret,events,active) VALUES
  (42,1,'https://127.0.0.1/private','whsec_private','project.update',1),
  (43,1,'https://hooks.example.test/callback','whsec_public','project.update',1);
`);
legacy.close();

process.env.SCOPEWEAVE_DB = databasePath;

try {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'server', 'db.mjs')).href;
  const first = await import(`${moduleUrl}?legacy-private-migration=first`);

  assert.deepEqual(
    {
      ...first.db.prepare(
        'SELECT active, blocked_reason AS blockedReason FROM webhooks WHERE id = 42',
      ).get(),
    },
    { active: 0, blockedReason: 'destination_policy' },
    'legacy HTTPS destinations rejected by the current registration policy are disabled before delivery retries begin',
  );
  assert.deepEqual(
    {
      ...first.db.prepare(
        'SELECT active, blocked_reason AS blockedReason FROM webhooks WHERE id = 43',
      ).get(),
    },
    { active: 1, blockedReason: null },
    'legacy public HTTPS destinations remain enabled',
  );

  const firstAudit = first.db.prepare(
    `SELECT action, target_type AS targetType, target_id AS targetId, meta
       FROM audit_log
      WHERE org_id = 1 AND action = 'webhook.security_block' AND target_id = '42'`,
  ).all();
  assert.equal(firstAudit.length, 1, 'policy-incompatible legacy HTTPS rows emit one durable security audit event');
  assert.equal(firstAudit[0].targetType, 'webhook');
  assert.deepEqual(
    JSON.parse(firstAudit[0].meta),
    {
      reason: 'destination_policy',
      nextAction: 'register_public_https_replacement',
    },
    'audit evidence explains why delivery was blocked and gives the tenant a concrete replacement action',
  );
  first.db.close();

  const second = await import(`${moduleUrl}?legacy-private-migration=second`);
  assert.equal(
    second.db.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_log
        WHERE org_id = 1 AND action = 'webhook.security_block' AND target_id = '42'`,
    ).get().count,
    1,
    'restarting after migration does not duplicate tenant audit evidence',
  );
  assert.deepEqual(
    {
      ...second.db.prepare(
        'SELECT active, blocked_reason AS blockedReason FROM webhooks WHERE id = 42',
      ).get(),
    },
    { active: 0, blockedReason: 'destination_policy' },
    'policy-incompatible legacy destinations remain fail-closed on later starts',
  );
  assert.deepEqual(
    {
      ...second.db.prepare(
        'SELECT active, blocked_reason AS blockedReason FROM webhooks WHERE id = 43',
      ).get(),
    },
    { active: 1, blockedReason: null },
    'policy-compliant legacy destinations remain active on later starts',
  );
  second.db.close();
} finally {
  delete process.env.SCOPEWEAVE_DB;
  rmSync(directory, { recursive: true, force: true });
}

console.log('legacy private HTTPS webhook migration regression passed');
