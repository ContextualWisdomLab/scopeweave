// ScopeWeave SaaS data layer.
// ponytail: node:sqlite (zero-dep, built into Node 22+) for dev/self-host.
// Schema is Postgres-portable; swap the driver for managed Postgres in prod.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createSqliteBillingCheckoutAttemptRepository,
  installBillingCheckoutAttemptSchema,
} from './billing_checkout_attempt.mjs';
import {
  configureStripeWebhookEventRecorder,
  createSqliteStripeWebhookEventRepository,
  installStripeWebhookEventSchema,
} from './stripe_webhook_event_ledger.mjs';
import {
  createSqliteStripeWebhookReconciliationQueue,
  extractStripeSubscriptionReconciliationCandidate,
  installStripeWebhookReconciliationQueueSchema,
} from './stripe_webhook_reconciliation_queue.mjs';
import {
  createSqliteStripeSubscriptionObservationRepository,
  installStripeSubscriptionObservationSchema,
} from './stripe_subscription_observation_ledger.mjs';
import {
  createSqliteStripeInvoiceObservationRepository,
  installStripeInvoiceObservationSchema,
} from './stripe_invoice_observation_ledger.mjs';
import { deriveStripeSubscriptionEntitlement } from './stripe_entitlement_policy.mjs';
import {
  createSqliteStripeEntitlementClaimRepository,
  installStripeEntitlementClaimSchema,
} from './stripe_entitlement_claim_ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SCOPEWEAVE_DB || join(__dirname, '..', 'data.db');
const STRIPE_WEBHOOK_RECONCILIATION_SAVEPOINT = 'billing_stripe_webhook_reconciliation_record';
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
  archived INTEGER NOT NULL DEFAULT 0,
  methodology TEXT NOT NULL DEFAULT 'waterfall',
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
CREATE TABLE IF NOT EXISTS sprints (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id, id);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_project ON attachments(project_id, id);
CREATE TABLE IF NOT EXISTS share_tokens (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_share_tokens ON share_tokens(token);
CREATE TABLE IF NOT EXISTS project_seen (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
`);

// Migration for pre-existing DBs: add token_version if missing (idempotent).
try { db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
try { db.exec('ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
try { db.exec("ALTER TABLE projects ADD COLUMN methodology TEXT NOT NULL DEFAULT 'waterfall'"); } catch { /* already there */ }

// Billing state is installed at bootstrap only; request handlers never create schema.
installBillingCheckoutAttemptSchema(db);
export const billingCheckoutAttempts = createSqliteBillingCheckoutAttemptRepository(db);
installStripeWebhookEventSchema(db);
export const stripeWebhookEvents = createSqliteStripeWebhookEventRepository(db);
installStripeWebhookReconciliationQueueSchema(db);
export const stripeWebhookReconciliationQueue = createSqliteStripeWebhookReconciliationQueue(db);
configureStripeWebhookEventRecorder((evidence) => {
  db.exec(`SAVEPOINT ${STRIPE_WEBHOOK_RECONCILIATION_SAVEPOINT}`);
  try {
    const eventReceipt = stripeWebhookEvents.recordVerifiedEvent(evidence);
    const subscriptionId = extractStripeSubscriptionReconciliationCandidate(evidence.event);
    if (subscriptionId) {
      stripeWebhookReconciliationQueue.enqueue({
        eventId: eventReceipt.eventId,
        subscriptionId,
      });
    }
    db.exec(`RELEASE SAVEPOINT ${STRIPE_WEBHOOK_RECONCILIATION_SAVEPOINT}`);
    return eventReceipt;
  } catch (error) {
    let rollbackSucceeded = false;
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${STRIPE_WEBHOOK_RECONCILIATION_SAVEPOINT}`);
      rollbackSucceeded = true;
    } catch {
      // Keep an unconfirmed failed savepoint open instead of risking a partial commit.
    }
    if (rollbackSucceeded) {
      try {
        db.exec(`RELEASE SAVEPOINT ${STRIPE_WEBHOOK_RECONCILIATION_SAVEPOINT}`);
      } catch {
        // Cleanup after confirmed rollback must not replace the causal operation error.
      }
    }
    throw error;
  }
});
installStripeSubscriptionObservationSchema(db);
export const stripeSubscriptionObservations = createSqliteStripeSubscriptionObservationRepository(db);
installStripeInvoiceObservationSchema(db);
export const stripeInvoiceObservations = createSqliteStripeInvoiceObservationRepository(db);
installStripeEntitlementClaimSchema(db);
export const stripeEntitlementClaims = createSqliteStripeEntitlementClaimRepository(db, {
  deriveEntitlement: deriveStripeSubscriptionEntitlement,
});

// node:sqlite returns lastInsertRowid as number|bigint; normalize to Number.
export const rowid = (r) => Number(r.lastInsertRowid);
