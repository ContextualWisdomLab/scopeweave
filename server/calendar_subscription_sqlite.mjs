const INSERT_SAVEPOINT = 'calendar_subscription_insert_state';
const USAGE_SAVEPOINT = 'calendar_subscription_usage_state';
const ROTATE_SAVEPOINT = 'calendar_subscription_rotate_state';
const REVOKE_SAVEPOINT = 'calendar_subscription_revoke_state';
const CALENDAR_AUDIENCE = 'scopeweave:calendar';
const CALENDAR_PURPOSE = 'calendar_read';
const DEFAULT_USAGE_EVENT_LIMIT = 256;

function requireDatabase(database) {
  if (!database || typeof database.exec !== 'function' || typeof database.prepare !== 'function') {
    throw new TypeError('calendar-subscription SQLite adapter requires a database with exec() and prepare()');
  }
  return database;
}

function normalizeSubscriptionRow(row) {
  if (!row) return null;
  return {
    ...row,
    subject_id: String(row.subject_id),
    project_id: String(row.project_id),
  };
}

function withSavepoint(database, savepointName, operation) {
  database.exec(`SAVEPOINT ${savepointName}`);
  try {
    const result = operation();
    database.exec(`RELEASE ${savepointName}`);
    return result;
  } catch (error) {
    let rollbackSucceeded = false;
    try {
      database.exec(`ROLLBACK TO ${savepointName}`);
      rollbackSucceeded = true;
    } catch {
      // An unconfirmed rollback must leave the savepoint open rather than risk committing failed state.
    }
    if (rollbackSucceeded) {
      try {
        database.exec(`RELEASE ${savepointName}`);
      } catch {
        // Cleanup failure must never replace the causal operation error after state is rolled back.
      }
    }
    throw error;
  }
}

function membershipVersionStatement(database) {
  return database.prepare(`
    SELECT CAST(m.id AS TEXT) || ':' || CAST(u.token_version AS TEXT) AS membership_version
      FROM projects p
      JOIN memberships m ON m.org_id = p.org_id
      JOIN users u ON u.id = m.user_id
     WHERE p.id = ? AND m.user_id = ?
  `);
}

function matchLiveMembershipVersion(statement, projectId, subjectId, expectedVersion) {
  const live = statement.get(projectId, subjectId);
  if (!live?.membership_version || String(live.membership_version) !== String(expectedVersion)) {
    return null;
  }
  return String(live.membership_version);
}

function assertLiveMembershipVersion(statement, projectId, subjectId, expectedVersion) {
  const membershipVersion = matchLiveMembershipVersion(
    statement,
    projectId,
    subjectId,
    expectedVersion,
  );
  if (!membershipVersion) {
    throw new Error('calendar_subscription_membership_inactive');
  }
  return membershipVersion;
}

/**
 * Freeze the ICS-only purpose when a parent domain record omits it.
 *
 * The current stacked parent (#539) still emits audience without purpose.
 * Persistence must not fail closed on that omission, and it must not accept a
 * broader purpose such as a session credential. An explicit non-calendar value
 * is passed through so the conditional UPDATE/INSERT CHECK can reject it.
 *
 * @param {unknown} value Caller-supplied purpose, if any.
 * @returns {string} `calendar_read` or the explicit supplied value.
 */
function resolveCalendarPurpose(value) {
  if (value == null || value === '') return CALENDAR_PURPOSE;
  return String(value);
}

/**
 * Install normalized durable storage for reusable calendar subscriptions.
 *
 * The authorization relation stores only the currently active SHA-256 secret
 * hash plus the fixed `calendar_read` purpose and the membership/session epoch
 * captured when the credential was issued or rotated. Rotation and bounded
 * usage relations contain lifecycle facts only and never retain plaintext
 * credentials or historical hashes. The audit outbox intentionally has no
 * foreign key to the live subscription so lifecycle security-event evidence
 * survives resource deletion; high-frequency read usage is retained in the
 * bounded usage relation instead of accumulating durable outbox rows.
 *
 * Call this during database bootstrap with foreign-key enforcement enabled.
 * Request handlers must never perform schema installation.
 *
 * @param {object} database Node SQLite-compatible database handle.
 * @returns {void}
 */
export function installCalendarSubscriptionSchema(database) {
  const db = requireDatabase(database);
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL CHECK(length(secret_hash) = 64),
      subject_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
      purpose TEXT NOT NULL CHECK(purpose = '${CALENDAR_PURPOSE}'),
      audience TEXT NOT NULL CHECK(audience = '${CALENDAR_AUDIENCE}'),
      membership_version TEXT NOT NULL CHECK(length(membership_version) BETWEEN 1 AND 128),
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
      last_used_at_ms INTEGER,
      rotated_at_ms INTEGER,
      revoked_at_ms INTEGER,
      CHECK(last_used_at_ms IS NULL OR last_used_at_ms >= created_at_ms),
      CHECK(rotated_at_ms IS NULL OR rotated_at_ms >= created_at_ms),
      CHECK(revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS calendar_subscription_secret_hash_index
      ON calendar_subscriptions(secret_hash);
    CREATE INDEX IF NOT EXISTS calendar_subscription_subject_project_index
      ON calendar_subscriptions(subject_id, project_id, revoked_at_ms, expires_at_ms);

    CREATE TABLE IF NOT EXISTS subscription_rotations (
      rotation_event_id INTEGER PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES calendar_subscriptions(subscription_id) ON DELETE CASCADE,
      rotated_at_ms INTEGER NOT NULL CHECK(rotated_at_ms >= 0),
      expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > rotated_at_ms)
    );
    CREATE INDEX IF NOT EXISTS subscription_rotation_history_index
      ON subscription_rotations(subscription_id, rotated_at_ms);

    CREATE TABLE IF NOT EXISTS subscription_usage_events (
      usage_event_id INTEGER PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES calendar_subscriptions(subscription_id) ON DELETE CASCADE,
      used_at_ms INTEGER NOT NULL CHECK(used_at_ms >= 0)
    );
    CREATE INDEX IF NOT EXISTS subscription_usage_history_index
      ON subscription_usage_events(subscription_id, used_at_ms);

    CREATE TABLE IF NOT EXISTS calendar_subscription_audit_outbox (
      audit_event_id INTEGER PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('created', 'used', 'rotated', 'revoked')),
      subject_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
      delivered_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS calendar_subscription_audit_delivery_index
      ON calendar_subscription_audit_outbox(delivered_at_ms, audit_event_id);
  `);
}

/**
 * Create the SQLite implementation of the CalendarSubscriptionRepository port.
 *
 * Every security transition uses a savepoint so it composes with a wider caller
 * transaction while still rolling back lifecycle state and durable audit-outbox
 * evidence together. Create and rotate compare the membership version supplied
 * by the domain with live database membership inside that transaction. Usage
 * binds the supplied issuance epoch to both the stored row and independently
 * resolved live membership in the same conditional UPDATE, so remove-then-rejoin
 * cannot revive a durable calendar credential. Purpose and audience are checked
 * at the same persistence boundary. Rotation is the only path that can bind the
 * credential to a newly authorized membership epoch.
 *
 * High-frequency successful reads keep `last_used_at_ms` plus only the most
 * recent configured usage-event window. A transient `used` outbox insert remains
 * inside the same savepoint as the usage transition so an outbox write failure
 * still rolls back authorization evidence, but those read-only outbox rows are
 * pruned before commit; durable outbox backlog is reserved for lifecycle events.
 *
 * Management list and revoke queries independently require live project
 * membership, so authorization loss between domain preflight and persistence
 * cannot disclose metadata or mutate state. Rotation replaces the sole current
 * hash; no historical credential hash is copied into history relations.
 *
 * @param {object} database Node SQLite-compatible database handle.
 * @param {{usageEventLimit?: number}} [options] Bounded per-subscription recent-use retention.
 * @returns {{insertSubscription: Function, listSubscriptions: Function, findSubscriptionByHash: Function, recordUsageAtomically: Function, rotateSubscriptionAtomically: Function, revokeSubscriptionAtomically: Function}} Repository adapter.
 */
export function createSqliteCalendarSubscriptionRepository(database, options = {}) {
  const db = requireDatabase(database);
  const usageEventLimit = Math.max(
    1,
    Math.min(10_000, Math.trunc(Number(options.usageEventLimit) || DEFAULT_USAGE_EVENT_LIMIT)),
  );
  const liveMembershipVersion = membershipVersionStatement(db);
  const insertSubscription = db.prepare(`
    INSERT INTO calendar_subscriptions(
      subscription_id, secret_hash, subject_id, project_id, name, purpose,
      audience, membership_version, created_at_ms, expires_at_ms, last_used_at_ms,
      rotated_at_ms, revoked_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const listSubscriptions = db.prepare(`
    SELECT *
      FROM calendar_subscriptions
     WHERE subject_id = ?
       AND project_id = ?
       AND EXISTS (
         SELECT 1
           FROM projects p
           JOIN memberships m ON m.org_id = p.org_id
          WHERE p.id = calendar_subscriptions.project_id
            AND m.user_id = calendar_subscriptions.subject_id
       )
     ORDER BY created_at_ms DESC, subscription_id ASC
  `);
  const findByHash = db.prepare('SELECT * FROM calendar_subscriptions WHERE secret_hash = ?');
  const findScopedById = db.prepare(`
    SELECT *
      FROM calendar_subscriptions
     WHERE subscription_id = ? AND subject_id = ? AND project_id = ?
  `);
  const findManageableScopedById = db.prepare(`
    SELECT *
      FROM calendar_subscriptions
     WHERE subscription_id = ?
       AND subject_id = ?
       AND project_id = ?
       AND EXISTS (
         SELECT 1
           FROM projects p
           JOIN memberships m ON m.org_id = p.org_id
          WHERE p.id = calendar_subscriptions.project_id
            AND m.user_id = calendar_subscriptions.subject_id
       )
  `);
  const recordUsage = db.prepare(`
    UPDATE calendar_subscriptions
       SET last_used_at_ms = CASE
         WHEN last_used_at_ms IS NULL OR last_used_at_ms < ? THEN ?
         ELSE last_used_at_ms
       END
     WHERE secret_hash = ?
       AND project_id = ?
       AND purpose = ?
       AND audience = ?
       AND revoked_at_ms IS NULL
       AND ? >= created_at_ms
       AND ? < expires_at_ms
       AND membership_version = ?
       AND EXISTS (
         SELECT 1
           FROM projects p
           JOIN memberships m ON m.org_id = p.org_id
           JOIN users u ON u.id = m.user_id
          WHERE p.id = calendar_subscriptions.project_id
            AND m.user_id = calendar_subscriptions.subject_id
            AND (CAST(m.id AS TEXT) || ':' || CAST(u.token_version AS TEXT)) = ?
       )
  `);
  const replaceSecret = db.prepare(`
    UPDATE calendar_subscriptions
       SET secret_hash = ?,
           membership_version = ?,
           expires_at_ms = ?,
           rotated_at_ms = ?
     WHERE subscription_id = ?
       AND subject_id = ?
       AND project_id = ?
       AND purpose = ?
       AND revoked_at_ms IS NULL
       AND ? >= created_at_ms
       AND ? < expires_at_ms
       AND ? > ?
       AND EXISTS (
         SELECT 1
           FROM projects p
           JOIN memberships m ON m.org_id = p.org_id
           JOIN users u ON u.id = m.user_id
          WHERE p.id = calendar_subscriptions.project_id
            AND m.user_id = calendar_subscriptions.subject_id
            AND (CAST(m.id AS TEXT) || ':' || CAST(u.token_version AS TEXT)) = ?
       )
  `);
  const revokeSubscription = db.prepare(`
    UPDATE calendar_subscriptions
       SET revoked_at_ms = ?
     WHERE subscription_id = ?
       AND subject_id = ?
       AND project_id = ?
       AND revoked_at_ms IS NULL
       AND EXISTS (
         SELECT 1
           FROM projects p
           JOIN memberships m ON m.org_id = p.org_id
          WHERE p.id = calendar_subscriptions.project_id
            AND m.user_id = calendar_subscriptions.subject_id
       )
  `);
  const insertRotation = db.prepare(`
    INSERT INTO subscription_rotations(subscription_id, rotated_at_ms, expires_at_ms)
    VALUES(?,?,?)
  `);
  const insertUsage = db.prepare(`
    INSERT INTO subscription_usage_events(subscription_id, used_at_ms)
    VALUES(?,?)
  `);
  const pruneUsage = db.prepare(`
    DELETE FROM subscription_usage_events
     WHERE subscription_id = ?
       AND usage_event_id NOT IN (
         SELECT usage_event_id
           FROM subscription_usage_events
          WHERE subscription_id = ?
          ORDER BY usage_event_id DESC
          LIMIT ?
       )
  `);
  const insertAudit = db.prepare(`
    INSERT INTO calendar_subscription_audit_outbox(
      subscription_id, event_type, subject_id, project_id, occurred_at_ms, delivered_at_ms
    ) VALUES(?,?,?,?,?,NULL)
  `);
  const pruneUsageAudit = db.prepare(`
    DELETE FROM calendar_subscription_audit_outbox
     WHERE subscription_id = ? AND event_type = 'used'
  `);

  return Object.freeze({
    /**
     * Persist one hash-only subscription after atomically rechecking the live
     * membership version captured by the domain.
     */
    async insertSubscription(record) {
      withSavepoint(db, INSERT_SAVEPOINT, () => {
        const membershipVersion = assertLiveMembershipVersion(
          liveMembershipVersion,
          record.project_id,
          record.subject_id,
          record.membership_version,
        );
        insertSubscription.run(
          record.subscription_id,
          record.secret_hash,
          record.subject_id,
          record.project_id,
          record.name,
          resolveCalendarPurpose(record.purpose),
          record.audience,
          membershipVersion,
          record.created_at_ms,
          record.expires_at_ms,
          record.last_used_at_ms,
          record.rotated_at_ms,
          record.revoked_at_ms,
        );
        insertAudit.run(
          record.subscription_id,
          'created',
          record.subject_id,
          record.project_id,
          record.created_at_ms,
        );
      });
    },

    /**
     * List scoped records only while the subject remains a live member of the
     * project's organization at the persistence boundary.
     */
    async listSubscriptions({ subject_id: subjectId, project_id: projectId }) {
      return listSubscriptions.all(subjectId, projectId).map(normalizeSubscriptionRow);
    },

    /** Resolve the current reusable credential by its one-way SHA-256 hash. */
    async findSubscriptionByHash(secretHash) {
      return normalizeSubscriptionRow(findByHash.get(secretHash));
    },

    /**
     * Record one successful use while comparing the stored issuance epoch with
     * the caller-supplied issuance epoch and live membership in one transition.
     */
    async recordUsageAtomically(secretHash, binding) {
      return withSavepoint(db, USAGE_SAVEPOINT, () => {
        const membershipVersion = String(binding.membership_version);
        const result = recordUsage.run(
          binding.now_ms,
          binding.now_ms,
          secretHash,
          binding.project_id,
          resolveCalendarPurpose(binding.purpose),
          binding.audience,
          binding.now_ms,
          binding.now_ms,
          membershipVersion,
          membershipVersion,
        );
        if (Number(result.changes) !== 1) return null;
        const current = findByHash.get(secretHash);
        insertUsage.run(current.subscription_id, binding.now_ms);
        pruneUsage.run(current.subscription_id, current.subscription_id, usageEventLimit);
        insertAudit.run(
          current.subscription_id,
          'used',
          current.subject_id,
          current.project_id,
          binding.now_ms,
        );
        pruneUsageAudit.run(current.subscription_id);
        return normalizeSubscriptionRow(current);
      });
    },

    /**
     * Atomically replace the sole active secret hash and bind it to the current
     * live membership version. The prior hash is not retained anywhere. A
     * membership change after the domain preflight returns `null` so the domain
     * preserves its stable tenant-nondisclosing not-found boundary.
     */
    async rotateSubscriptionAtomically(subscriptionId, binding) {
      return withSavepoint(db, ROTATE_SAVEPOINT, () => {
        const membershipVersion = matchLiveMembershipVersion(
          liveMembershipVersion,
          binding.project_id,
          binding.subject_id,
          binding.membership_version,
        );
        if (!membershipVersion) return null;
        const result = replaceSecret.run(
          binding.new_secret_hash,
          membershipVersion,
          binding.expires_at_ms,
          binding.now_ms,
          subscriptionId,
          binding.subject_id,
          binding.project_id,
          resolveCalendarPurpose(binding.purpose),
          binding.now_ms,
          binding.now_ms,
          binding.expires_at_ms,
          binding.now_ms,
          membershipVersion,
        );
        if (Number(result.changes) !== 1) return null;
        const current = findScopedById.get(subscriptionId, binding.subject_id, binding.project_id);
        insertRotation.run(subscriptionId, binding.now_ms, binding.expires_at_ms);
        insertAudit.run(
          subscriptionId,
          'rotated',
          current.subject_id,
          current.project_id,
          binding.now_ms,
        );
        return normalizeSubscriptionRow(current);
      });
    },

    /**
     * Revoke a subscription idempotently while independently requiring current
     * project membership. `revocation_applied` is true only for the first state
     * transition so callers cannot emit duplicate external audit events on a
     * same-millisecond or later retry.
     */
    async revokeSubscriptionAtomically(subscriptionId, binding) {
      return withSavepoint(db, REVOKE_SAVEPOINT, () => {
        const existing = findManageableScopedById.get(
          subscriptionId,
          binding.subject_id,
          binding.project_id,
        );
        if (!existing) return null;
        if (existing.revoked_at_ms !== null && existing.revoked_at_ms !== undefined) {
          return {
            ...normalizeSubscriptionRow(existing),
            revocation_applied: false,
          };
        }
        const result = revokeSubscription.run(
          binding.now_ms,
          subscriptionId,
          binding.subject_id,
          binding.project_id,
        );
        if (Number(result.changes) !== 1) return null;
        const current = findScopedById.get(subscriptionId, binding.subject_id, binding.project_id);
        insertAudit.run(
          subscriptionId,
          'revoked',
          current.subject_id,
          current.project_id,
          binding.now_ms,
        );
        return {
          ...normalizeSubscriptionRow(current),
          revocation_applied: true,
        };
      });
    },
  });
}

/**
 * Create project-management authorization for calendar subscription lifecycle.
 *
 * The same nondisclosing absence error is used for an unknown project and for a
 * project outside the subject's organization. HTTP adapters can therefore map
 * the domain's management failure without revealing tenant existence.
 *
 * @param {object} database Node SQLite-compatible database handle.
 * @returns {{assertCanManage: Function}} Authorization port.
 */
export function createSqliteCalendarSubscriptionAuthorizationPort(database) {
  const db = requireDatabase(database);
  const projectAccess = db.prepare(`
    SELECT p.id
      FROM projects p
      JOIN memberships m ON m.org_id = p.org_id
     WHERE p.id = ? AND m.user_id = ?
  `);

  return Object.freeze({
    /** Verify that the subject currently belongs to the project's organization. */
    async assertCanManage({ subjectId, projectId }) {
      if (!projectAccess.get(projectId, subjectId)) {
        throw new Error('calendar_subscription_resource_unavailable');
      }
    },
  });
}

/**
 * Create the live membership-version port used before calendar credential use.
 *
 * The opaque version combines membership-row identity with the user's session
 * token version. Removing/re-adding membership changes the first component;
 * logout-all or password/session invalidation changes the second. Repository
 * transitions compare this live value in their own savepoint before committing.
 *
 * @param {object} database Node SQLite-compatible database handle.
 * @returns {{assertActive: Function}} Membership revocation/version port.
 */
export function createSqliteCalendarSubscriptionMembershipPort(database) {
  const db = requireDatabase(database);
  const activeMembership = membershipVersionStatement(db);

  return Object.freeze({
    /** Return the current opaque membership/session version for one project. */
    async assertActive({ subjectId, projectId }) {
      const row = activeMembership.get(projectId, subjectId);
      if (!row?.membership_version) {
        throw new Error('calendar_subscription_membership_inactive');
      }
      return String(row.membership_version);
    },
  });
}
