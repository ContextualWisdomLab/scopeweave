// Durable OpenID Connect identity binding for production authentication.
//
// OpenID Connect only guarantees the pair (issuer, subject) as a stable user
// identifier. Verified email remains useful profile data, but it must not become
// the long-lived account key or implicitly authorize cross-method account linking.
import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth.mjs';
import { db, rowid } from './db.mjs';

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
 * Bind a provider-verified OIDC identity before the legacy callback consumes it.
 *
 * Existing issuer/subject links remain authoritative even when the provider's
 * verified email changes. An unlinked local row with the same email is rejected
 * rather than silently adopted: verified email proves the provider's assertion,
 * not authorization to merge a password account or an unverifiable legacy SSO
 * account.
 *
 * A first-time federated login provisions its local user, personal workspace,
 * owner membership, and durable issuer/subject link in one SQLite write
 * transaction. That transaction is intentionally synchronous and contains no
 * provider/network work. The password hash used only as an inaccessible local
 * fallback is prepared before taking the database write lock on the normal
 * first-login path. All identity and email collision checks are repeated while
 * the write lock is held, closing the check-then-create race with another auth
 * request or process.
 *
 * @param {{issuer:string,subject:string,email:string}} identity - Cryptographically verified OIDC identity.
 * @returns {{userId:number,needsFinalization:false,created:boolean}} Bound local identity metadata.
 */
export function prepareOidcIdentity(identity) {
  const { issuer, subject, email } = validatedIdentity(identity);

  // Avoid paying the scrypt cost on established logins. If the link disappears
  // before the write lock is acquired, the rare fallback below prepares the hash
  // inside the transaction rather than creating an unbound account.
  const linkedBeforeLock = linkedUser(issuer, subject);
  let passwordHash = linkedBeforeLock
    ? null
    : hashPassword(randomBytes(24).toString('hex'));

  db.exec('BEGIN IMMEDIATE');
  try {
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
      db.exec('COMMIT');
      return { userId: linked.id, needsFinalization: false, created: false };
    }

    const users = matchingUsers(email);
    if (users.length > 0) throw new OidcIdentityConflictError();

    // This path is only possible when a previously observed link was removed
    // before BEGIN IMMEDIATE. Keep the transaction safe rather than depending on
    // the optimistic pre-lock observation.
    if (!passwordHash) passwordHash = hashPassword(randomBytes(24).toString('hex'));

    const userId = rowid(
      db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)')
        .run(email, passwordHash, ''),
    );
    const orgId = rowid(
      db.prepare('INSERT INTO orgs(name,owner_id) VALUES(?,?)')
        .run(`${email}'s workspace`, userId),
    );
    db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)')
      .run(orgId, userId, 'owner');
    db.prepare(
      `INSERT INTO oidc_identity_links(
         issuer_url, subject_identifier, user_id, email_at_link
       ) VALUES(?,?,?,?)`,
    ).run(issuer, subject, userId, email);

    db.exec('COMMIT');
    return { userId, needsFinalization: false, created: true };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Compatibility finalizer for callers that still carry the historical two-step
 * contract. New production OIDC flows bind during prepareOidcIdentity and do not
 * require this function.
 *
 * @param {{issuer:string,subject:string,email:string}} identity - Verified OIDC identity.
 * @returns {number} Bound local user identifier.
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
