import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateLegacyWebhookDestinations } from '../../server/webhook_legacy_migration.mjs';

function createDatabase(path = ':memory:') {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE webhooks (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      user_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      meta TEXT
    );
  `);
  return database;
}

function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

const production = createDatabase();
production.exec(`
  INSERT INTO webhooks(id,org_id,url,active) VALUES
    (1,7,'http://legacy.example.test/hook',1),
    (2,7,'http://localhost:8080/hook',1),
    (3,7,'https://public.example.test/hook',1),
    (4,7,'http://retired.example.test/hook',0),
    (5,7,'https://localhost/hook',1),
    (6,7,'https://127.0.0.1/hook',1),
    (7,7,'https://10.0.0.8/hook',1);
`);
assert.equal(
  migrateLegacyWebhookDestinations(production),
  5,
  'production disables every active historical destination rejected by the current registration policy',
);
assert.deepEqual(
  plainRows(production.prepare('SELECT id, active FROM webhooks ORDER BY id').all()),
  [
    { id: 1, active: 0 },
    { id: 2, active: 0 },
    { id: 3, active: 1 },
    { id: 4, active: 0 },
    { id: 5, active: 0 },
    { id: 6, active: 0 },
    { id: 7, active: 0 },
  ],
);
assert.equal(
  production.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'webhook.security_block'").get().count,
  5,
  'each newly disabled production row gets one tenant-visible security audit event',
);
assert.deepEqual(
  plainRows(production.prepare("SELECT DISTINCT meta FROM audit_log WHERE action = 'webhook.security_block'").all()),
  [{ meta: JSON.stringify({ reason: 'destination_policy', nextAction: 'register_public_https_replacement' }) }],
  'audit evidence explains the current destination-policy incompatibility rather than assuming every row used HTTP',
);
assert.equal(
  migrateLegacyWebhookDestinations(production),
  0,
  'rerunning the migration is idempotent once incompatible rows are inactive',
);
assert.equal(
  production.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'webhook.security_block'").get().count,
  5,
  'idempotent restart does not duplicate audit evidence',
);
production.close();

const development = createDatabase();
development.exec(`
  INSERT INTO webhooks(id,org_id,url,active) VALUES
    (10,8,'http://localhost:8080/hook',1),
    (11,8,'http://127.0.0.8:8080/hook',1),
    (12,8,'http://[::1]:8080/hook',1),
    (13,8,'http://public.example.test/hook',1),
    (14,8,'http://localhost.evil.example/hook',1),
    (15,8,'https://localhost/hook',1),
    (16,8,'https://public.example.test/hook',1);
`);
assert.equal(
  migrateLegacyWebhookDestinations(development, { allowDevelopmentLoopback: true }),
  3,
  'explicit development mode preserves only admitted loopback HTTP and public HTTPS destinations',
);
assert.deepEqual(
  plainRows(development.prepare('SELECT id, active FROM webhooks ORDER BY id').all()),
  [
    { id: 10, active: 1 },
    { id: 11, active: 1 },
    { id: 12, active: 1 },
    { id: 13, active: 0 },
    { id: 14, active: 0 },
    { id: 15, active: 0 },
    { id: 16, active: 1 },
  ],
);
development.close();

const rollback = createDatabase();
rollback.exec(`
  INSERT INTO webhooks(id,org_id,url,active)
  VALUES(20,9,'https://127.0.0.1/hook',1);
  CREATE TRIGGER reject_security_audit
  BEFORE INSERT ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit write rejected');
  END;
`);
assert.throws(
  () => migrateLegacyWebhookDestinations(rollback),
  /audit write rejected/,
  'migration fails closed when durable audit evidence cannot be written',
);
assert.equal(
  rollback.prepare('SELECT active FROM webhooks WHERE id = 20').get().active,
  1,
  'failed audit persistence rolls back the webhook mutation atomically',
);
assert.equal(
  rollback.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count,
  0,
  'failed migration leaves no partial audit record',
);
assert.doesNotThrow(
  () => rollback.exec('BEGIN IMMEDIATE; COMMIT;'),
  'rollback releases the write transaction for subsequent startup work',
);
rollback.close();

const contentionDirectory = mkdtempSync(join(tmpdir(), 'scopeweave-webhook-migration-'));
const contentionPath = join(contentionDirectory, 'scopeweave.sqlite');
const contended = createDatabase(contentionPath);
const writer = new DatabaseSync(contentionPath);
try {
  contended.exec(`
    PRAGMA busy_timeout = 0;
    INSERT INTO webhooks(id,org_id,url,active)
    VALUES(30,10,'https://public.example.test/hook',1);
  `);
  writer.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
  assert.doesNotThrow(
    () => assert.equal(migrateLegacyWebhookDestinations(contended), 0),
    'a compliant no-op startup migration must not require the database write reservation',
  );
} finally {
  writer.exec('ROLLBACK');
  writer.close();
  contended.close();
  rmSync(contentionDirectory, { recursive: true, force: true });
}

console.log('legacy webhook migration unit tests passed');
