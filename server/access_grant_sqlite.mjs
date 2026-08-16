const ATTACHMENT_VIEW_PURPOSE = 'attachment_view';
const INSERT_SAVEPOINT = 'access_grant_insert_state';
const CONSUME_SAVEPOINT = 'access_grant_consume_state';

function requireDatabase(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('access-grant SQLite adapter requires a database with exec() and prepare()');
  }
  return db;
}

function normalizeGrantRow(row) {
  if (!row) return null;
  return {
    ...row,
    subject_id: String(row.subject_id),
    project_id: String(row.project_id),
    attachment_id: row.attachment_id == null ? null : String(row.attachment_id),
  };
}

function withSavepoint(db, name, operation) {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    let rollbackSucceeded = false;
    try {
      db.exec(`ROLLBACK TO ${name}`);
      rollbackSucceeded = true;
    } catch {
      // Leave an unconfirmed failed savepoint open rather than risk committing partial state.
    }
    if (rollbackSucceeded) {
      try {
        db.exec(`RELEASE ${name}`);
      } catch {
        // Cleanup failure after confirmed rollback must not replace the causal operation error.
      }
    }
    throw error;
  }
}

/**
 * Install the durable access-grant schema during database bootstrap.
 *
 * The usable-grant relation stores only SHA-256 token hashes and resource
 * bindings, including the opaque membership identity/session version captured
 * when the grant becomes durable. A separate immutable audit-outbox relation
 * records each successful security transition in the same SQLite transaction
 * while deliberately retaining evidence after subject/project/attachment
 * deletion. Schema DDL is installed at process/database bootstrap, never from
 * a request handler.
 *
 * @param {object} database Node SQLite-compatible database handle.
 * @returns {void}
 */
export function installAccessGrantSchema(database) {
  const db = requireDatabase(database);
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_grants (
      grant_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      subject_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      audience TEXT NOT NULL,
      attachment_id INTEGER REFERENCES attachments(id) ON DELETE CASCADE,
      membership_version TEXT NOT NULL,
      issued_at_ms INTEGER NOT NULL CHECK(issued_at_ms >= 0),
      expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > issued_at_ms),
      used_at_ms INTEGER,
      revoked_at_ms INTEGER,
      CHECK(used_at_ms IS NULL OR used_at_ms >= issued_at_ms),
      CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= issued_at_ms)
    );
    CREATE INDEX IF NOT EXISTS access_grant_token_hash_index
      ON access_grants(token_hash);
    CREATE INDEX IF NOT EXISTS access_grant_subject_resource_index
      ON access_grants(subject_id, project_id, purpose, attachment_id);

    CREATE TABLE IF NOT EXISTS access_grant_audit_outbox (
      event_id INTEGER PRIMARY KEY,
      grant_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('minted', 'consumed')),
      subject_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      audience TEXT NOT NULL,
      attachment_id INTEGER,
      occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
      delivered_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS access_grant_audit_delivery_index
      ON access_grant_audit_outbox(delivered_at_ms, event_id);
  `);
}

/**
 * Create the SQLite implementation of the AccessGrantRepository port.
 *
 * Mint persistence captures the current membership-row identity plus session
 * token version and commits that snapshot with the grant and immutable audit
 * evidence under one savepoint. One-time redemption is one conditional UPDATE
 * plus its immutable consume evidence under one savepoint. The consume condition
 * binds purpose, audience, resource, expiry, unused/unrevoked state, the
 * mint-time membership version, and the exact live membership version.
 * Concurrent consumers cannot both move the row from unused to used, and a
 * logout-all/password change or membership remove/re-add after mint invalidates
 * the outstanding grant.
 *
 * Savepoints make this adapter safe both as a top-level transaction boundary
 * and when a future caller already owns a wider SQLite transaction.
 *
 * @param {object} database Node SQLite-compatible database handle.
 * @returns {{insertGrant: Function, findGrantByHash: Function, consumeGrantAtomically: Function}}
 */
export function createSqliteAccessGrantRepository(database) {
  const db = requireDatabase(database);
  const membershipAtMint = db.prepare(`
    SELECT CAST(m.id AS TEXT) || ':' || CAST(u.token_version AS TEXT) AS membership_version
      FROM projects p
      JOIN memberships m ON m.org_id = p.org_id
      JOIN users u ON u.id = m.user_id
     WHERE p.id = ? AND m.user_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO access_grants(
      grant_id, token_hash, subject_id, project_id, purpose, audience,
      attachment_id, membership_version, issued_at_ms, expires_at_ms,
      used_at_ms, revoked_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const find = db.prepare('SELECT * FROM access_grants WHERE token_hash = ?');
  const insertAudit = db.prepare(`
    INSERT INTO access_grant_audit_outbox(
      grant_id, event_type, subject_id, project_id, purpose, audience,
      attachment_id, occurred_at_ms, delivered_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,NULL)
  `);
  const consume = db.prepare(`
    UPDATE access_grants
       SET used_at_ms = ?
     WHERE token_hash = ?
       AND purpose = ?
       AND audience = ?
       AND project_id = ?
       AND ((attachment_id IS NULL AND ? IS NULL) OR attachment_id = ?)
       AND used_at_ms IS NULL
       AND revoked_at_ms IS NULL
       AND ? < expires_at_ms
       AND membership_version = ?
       AND EXISTS (
         SELECT 1
           FROM projects p
           JOIN memberships m ON m.org_id = p.org_id
           JOIN users u ON u.id = m.user_id
          WHERE p.id = access_grants.project_id
            AND m.user_id = access_grants.subject_id
            AND (CAST(m.id AS TEXT) || ':' || CAST(u.token_version AS TEXT)) = ?
       )
  `);

  return Object.freeze({
    /**
     * Persist one already-validated hash-only grant and its durable mint event.
     * The current membership identity/session version is captured inside the
     * same savepoint. Either grant, snapshot, and audit evidence all commit or
     * none of them do.
     */
    async insertGrant(record) {
      withSavepoint(db, INSERT_SAVEPOINT, () => {
        const membership = membershipAtMint.get(record.project_id, record.subject_id);
        if (!membership?.membership_version) {
          throw new Error('access_grant_membership_inactive');
        }
        insert.run(
          record.grant_id,
          record.token_hash,
          record.subject_id,
          record.project_id,
          record.purpose,
          record.audience,
          record.attachment_id,
          String(membership.membership_version),
          record.issued_at_ms,
          record.expires_at_ms,
          record.used_at_ms,
          record.revoked_at_ms,
        );
        insertAudit.run(
          record.grant_id,
          'minted',
          record.subject_id,
          record.project_id,
          record.purpose,
          record.audience,
          record.attachment_id,
          record.issued_at_ms,
        );
      });
    },

    /** Resolve a grant by its one-way token hash without exposing a secret. */
    async findGrantByHash(tokenHash) {
      return normalizeGrantRow(find.get(tokenHash));
    },

    /**
     * Consume a grant exactly once while requiring the current membership
     * version to match both the mint-time snapshot and the live database state
     * inside the same conditional transition, with immutable consume evidence.
     */
    async consumeGrantAtomically(tokenHash, binding) {
      return withSavepoint(db, CONSUME_SAVEPOINT, () => {
        const currentMembershipVersion = String(binding.membership_version);
        const result = consume.run(
          binding.now_ms,
          tokenHash,
          binding.purpose,
          binding.audience,
          binding.project_id,
          binding.attachment_id,
          binding.attachment_id,
          binding.now_ms,
          currentMembershipVersion,
          currentMembershipVersion,
        );
        if (Number(result.changes) !== 1) return null;
        const consumed = find.get(tokenHash);
        insertAudit.run(
          consumed.grant_id,
          'consumed',
          consumed.subject_id,
          consumed.project_id,
          consumed.purpose,
          consumed.audience,
          consumed.attachment_id,
          binding.now_ms,
        );
        return normalizeGrantRow(consumed);
      });
    },
  });
}

/**
 * Create the project/resource authorization port used when minting grants.
 *
 * Attachment-view authorization succeeds only when the subject is a current
 * member of the owning organization and the exact attachment belongs to that
 * project and is already ready for viewing. All other states throw the same
 * error so the domain can map them to a tenant-nondisclosing response.
 *
 * @param {object} database Node SQLite-compatible database handle.
 * @returns {{assertCanIssue: Function}}
 */
export function createSqliteAccessGrantAuthorizationPort(database) {
  const db = requireDatabase(database);
  const projectAccess = db.prepare(`
    SELECT p.id
      FROM projects p
      JOIN memberships m ON m.org_id = p.org_id
     WHERE p.id = ? AND m.user_id = ?
  `);
  const attachmentAccess = db.prepare(`
    SELECT a.id
      FROM projects p
      JOIN memberships m ON m.org_id = p.org_id
      JOIN attachments a ON a.project_id = p.id
     WHERE p.id = ?
       AND m.user_id = ?
       AND a.id = ?
       AND a.status = 'SUCCEEDED'
  `);

  return Object.freeze({
    /** Verify current tenant/resource access before a secret is minted. */
    async assertCanIssue({ subjectId, projectId, purpose, attachmentId }) {
      const row = purpose === ATTACHMENT_VIEW_PURPOSE
        ? attachmentAccess.get(projectId, subjectId, attachmentId)
        : projectAccess.get(projectId, subjectId);
      if (!row) throw new Error('access_grant_resource_unavailable');
    },
  });
}

/**
 * Create the membership-revocation port used immediately before redemption.
 *
 * The version combines the durable membership-row identity with the user's
 * session token version. Membership removal/re-addition changes the former;
 * logout-all/password-style session invalidation changes the latter. The
 * repository compares this current version with both its mint-time snapshot
 * and live membership state inside the atomic consume statement.
 *
 * @param {object} database Node SQLite-compatible database handle.
 * @returns {{assertActive: Function}}
 */
export function createSqliteAccessGrantMembershipPort(database) {
  const db = requireDatabase(database);
  const activeMembership = db.prepare(`
    SELECT m.id AS membership_id, u.token_version AS token_version
      FROM projects p
      JOIN memberships m ON m.org_id = p.org_id
      JOIN users u ON u.id = m.user_id
     WHERE p.id = ? AND m.user_id = ?
  `);

  return Object.freeze({
    /** Return the opaque version that the repository must compare atomically. */
    async assertActive({ subjectId, projectId }) {
      const row = activeMembership.get(projectId, subjectId);
      if (!row) throw new Error('access_grant_membership_inactive');
      return `${row.membership_id}:${row.token_version}`;
    },
  });
}
