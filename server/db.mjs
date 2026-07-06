// ScopeWeave SaaS data layer.
// ponytail: node:sqlite (zero-dep, built into Node 22+) for dev/self-host.
// Schema is Postgres-portable; swap the driver for managed Postgres in prod.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SCOPEWEAVE_DB || join(__dirname, '..', 'data.db');
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  UNIQUE(org_id, user_id)
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_date TEXT NOT NULL DEFAULT '',
  tasks_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT UNIQUE NOT NULL,
  invited_by INTEGER NOT NULL REFERENCES users(id),
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '*',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  status_code INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wh_deliveries ON webhook_deliveries(webhook_id, id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, id);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  token_hash TEXT UNIQUE NOT NULL,
  prefix TEXT NOT NULL,
  last_used TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE TABLE IF NOT EXISTS baselines (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_date TEXT NOT NULL DEFAULT '',
  tasks_json TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_baselines_project ON baselines(project_id, id);
CREATE TABLE IF NOT EXISTS project_revisions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  base_date TEXT NOT NULL DEFAULT '',
  tasks_json TEXT NOT NULL DEFAULT '[]',
  saved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_revisions_project ON project_revisions(project_id, version);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_project ON comments(project_id, id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
`);

// Migration for pre-existing DBs: add token_version if missing (idempotent).
try { db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }

// node:sqlite returns lastInsertRowid as number|bigint; normalize to Number.
export const rowid = (r) => Number(r.lastInsertRowid);
