// Durable OpenID Connect identity binding for production authentication.
//
// OpenID Connect only guarantees the pair (issuer, subject) as a stable user
// identifier. Verified email remains useful profile data, but it must not become
// the long-lived account key after a federated identity has been observed.
import { db } from './db.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS oidc_identity_links (
  id INTEGER PRIMARY KEY,
  issuer_url TEXT NOT NULL,
  subject_identifier TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_at_link TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(issuer_url, subject_identifier),
  UNIQUE(issuer_url, user_id)
);
CREATE INDEX IF NOT EXISTS idx_oidc_identity_user
  ON oidc_identity_links(user_id, issuer_url);
`);

/** Error raised when a verified federated identity conflicts with a prior binding. */
export class OidcIdentityConflictError extends Error {
  constructor(message = 'federated identity conflicts with an existing account') {
    super(message);
    this.name = 'OidcIdentityConflictError';
  }
}

function validatedIdentity(identity) {
  const issuer = String(identity?.issuer || '').trim();
  const subject = String(identity?.subject || '').trim();
  const email = String(identity?.email || '').trim();
  if (!issuer || !subject || !email) throw new Error('invalid verified OIDC identity');
  return { issuer, subject, email };
}

function matchingUsers(email) {
  return db.prepare(
    'SELECT id, email, token_version FROM users WHERE email = ? COLLATE NOCASE ORDER BY id LIMIT 2',
  ).all(email);
}

function linkedUser(issuer, subject) {
  return db.prepare(
    `SELECT u.id, u.email, u.token_version
     FROM oidc_identity_links l
     JOIN users u ON u.id = l.user_id
     WHERE l.issuer_url = ? AND l.subject_identifier = ?`,
  ).get(issuer, subject);
}

/**
 * Prepare a verified OIDC identity before the legacy callback consumes it.
 *
 * Existing issuer/subject links remain authoritative even when the provider's
 * verified email changes. A one-time compatibility adoption is allowed for a
 * unique pre-existing email row, after which another subject or issuer cannot
 * silently claim that account by presenting the same mutable email address.
 * New federated users are finalized only after the core callback creates them.
 */
export function prepareOidcIdentity(identity) {
  const { issuer, subject, email } = validatedIdentity(identity);
  const linked = linkedUser(issuer, subject);
  if (linked) {
    const collision = db.prepare(
      'SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id <> ? LIMIT 1',
    ).get(email, linked.id);
    if (collision) throw new OidcIdentityConflictError();
    if (linked.email !== email) {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, linked.id);
    }
    db.prepare(
      `UPDATE oidc_identity_links
       SET email_at_link = ?, updated_at = datetime('now')
       WHERE issuer_url = ? AND subject_identifier = ?`,
    ).run(email, issuer, subject);
    return { userId: linked.id, needsFinalization: false };
  }

  const users = matchingUsers(email);
  if (users.length > 1) throw new OidcIdentityConflictError();
  const existing = users[0];
  if (!existing) return { userId: null, needsFinalization: true };

  const priorFederatedLink = db.prepare(
    `SELECT issuer_url, subject_identifier
     FROM oidc_identity_links
     WHERE user_id = ?
     LIMIT 1`,
  ).get(existing.id);
  if (priorFederatedLink) throw new OidcIdentityConflictError();

  db.prepare(
    `INSERT INTO oidc_identity_links(
       issuer_url, subject_identifier, user_id, email_at_link
     ) VALUES(?,?,?,?)`,
  ).run(issuer, subject, existing.id, email);
  return { userId: existing.id, needsFinalization: false };
}

/**
 * Finish binding a first-time federated identity after the core callback has
 * atomically created its local user and workspace.
 */
export function finalizeOidcIdentity(identity) {
  const { issuer, subject, email } = validatedIdentity(identity);
  const existingLink = linkedUser(issuer, subject);
  if (existingLink) return existingLink.id;

  const users = matchingUsers(email);
  if (users.length !== 1) throw new OidcIdentityConflictError();
  const user = users[0];
  const priorFederatedLink = db.prepare(
    `SELECT issuer_url, subject_identifier
     FROM oidc_identity_links
     WHERE user_id = ?
     LIMIT 1`,
  ).get(user.id);
  if (priorFederatedLink) throw new OidcIdentityConflictError();

  db.prepare(
    `INSERT INTO oidc_identity_links(
       issuer_url, subject_identifier, user_id, email_at_link
     ) VALUES(?,?,?,?)`,
  ).run(issuer, subject, user.id, email);
  return user.id;
}
