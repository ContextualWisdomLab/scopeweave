const COMMIT_SAVEPOINT = 'schedule_reason_event_commit_state';

function requireDatabase(database) {
  if (!database || typeof database.exec !== 'function' || typeof database.prepare !== 'function') {
    throw new TypeError('schedule reason-event SQLite adapter requires a database with exec() and prepare()');
  }
  return database;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  return value;
}

function withSavepoint(db, operation) {
  db.exec(`SAVEPOINT ${COMMIT_SAVEPOINT}`);
  try {
    const result = operation();
    db.exec(`RELEASE ${COMMIT_SAVEPOINT}`);
    return result;
  } catch (error) {
    let rollbackSucceeded = false;
    try {
      db.exec(`ROLLBACK TO ${COMMIT_SAVEPOINT}`);
      rollbackSucceeded = true;
    } catch {
      // Keep an unconfirmed failed savepoint open instead of risking a partial commit.
    }
    if (rollbackSucceeded) {
      try {
        db.exec(`RELEASE ${COMMIT_SAVEPOINT}`);
      } catch {
        // Cleanup after a confirmed rollback must not replace the causal operation error.
      }
    }
    throw error;
  }
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('schedule reason event must be an object');
  }
  const type = requireText(event.type, 'event.type');
  if (!['skipped', 'cancelled', 'not_performed'].includes(type)) {
    throw new TypeError('event.type is unsupported');
  }
  const approval = event.approval;
  if (type === 'cancelled' && (!approval || typeof approval !== 'object' || Array.isArray(approval))) {
    throw new TypeError('cancelled event requires verified approval evidence');
  }
  if (type !== 'cancelled' && approval !== null) {
    throw new TypeError('non-cancelled event cannot contain approval evidence');
  }
  return {
    eventId: requireText(event.eventId, 'event.eventId'),
    contractVersion: requireText(event.contractVersion, 'event.contractVersion'),
    organizationId: requireText(event.organizationId, 'event.organizationId'),
    projectId: requireText(event.projectId, 'event.projectId'),
    workItemId: requireText(event.workItemId, 'event.workItemId'),
    expectedWorkItemVersion: requireText(event.expectedWorkItemVersion, 'event.expectedWorkItemVersion'),
    type,
    reasonCode: requireText(event.reasonCode, 'event.reasonCode'),
    actorId: requireText(event.actorId, 'event.actorId'),
    occurredAt: requireText(event.occurredAt, 'event.occurredAt'),
    observedAt: requireText(event.observedAt, 'event.observedAt'),
    authorizationId: requireText(event.authorizationId, 'event.authorizationId'),
    approvalId: approval ? requireText(approval.approvalId, 'event.approval.approvalId') : null,
    approverId: approval ? requireText(approval.approverId, 'event.approval.approverId') : null,
    approvalAuthorizationId: approval
      ? requireText(approval.authorizationId, 'event.approval.authorizationId')
      : null,
  };
}

/**
 * Install the durable schedule reason-event relations during database bootstrap.
 *
 * Reason facts and immutable audit evidence are separated into 3NF relations.
 * No work-item authority is duplicated here: the repository receives a caller-
 * supplied version-transition function that must update the authoritative work-
 * item store on the same SQLite connection and inside the same savepoint.
 *
 * @param {object} database Node SQLite-compatible database handle.
 * @returns {void}
 */
export function installScheduleReasonEventSchema(database) {
  const db = requireDatabase(database);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_reason_events (
      event_id TEXT PRIMARY KEY,
      contract_version TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      prior_resource_version TEXT NOT NULL,
      committed_resource_version TEXT NOT NULL,
      reason_event_type TEXT NOT NULL CHECK(reason_event_type IN ('skipped', 'cancelled', 'not_performed')),
      reason_code TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      authorization_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedule_reason_event_resource_index
      ON schedule_reason_events(organization_id, project_id, work_item_id, event_id);

    CREATE TABLE IF NOT EXISTS schedule_reason_event_approval_records (
      event_id TEXT PRIMARY KEY REFERENCES schedule_reason_events(event_id) ON DELETE RESTRICT,
      approval_id TEXT NOT NULL,
      approver_id TEXT NOT NULL,
      approval_authorization_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedule_reason_approval_identity_index
      ON schedule_reason_event_approval_records(approval_id, event_id);

    CREATE TABLE IF NOT EXISTS schedule_reason_event_audit_records (
      audit_record_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE REFERENCES schedule_reason_events(event_id) ON DELETE RESTRICT,
      action_type TEXT NOT NULL CHECK(action_type = 'schedule_reason.recorded')
    );
  `);
}

/**
 * Create the SQLite ScheduleReasonEventRepository implementation.
 *
 * The injected `advanceResourceVersion` function owns optimistic concurrency for
 * the authoritative work-item store. It runs inside this adapter's savepoint and
 * must either return `{ advanced: true, resourceVersion }` after moving exactly
 * the expected version, or a falsey/non-advanced result for a stale write. Event,
 * version transition, and audit evidence therefore commit or roll back together.
 * The injected audit ID source keeps audit identities opaque without coupling the
 * domain event generator to persistence details.
 *
 * @param {object} database Node SQLite-compatible database handle.
 * @param {{advanceResourceVersion: Function, nextAuditRecordId: Function}} dependencies persistence dependencies.
 * @returns {{commitReasonEvent: Function}} immutable repository port.
 */
export function createSqliteScheduleReasonEventRepository(database, dependencies) {
  const db = requireDatabase(database);
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new TypeError('schedule reason-event SQLite dependencies must be an object');
  }
  const advanceResourceVersion = requireFunction(
    dependencies.advanceResourceVersion,
    'dependencies.advanceResourceVersion',
  );
  const nextAuditRecordId = requireFunction(
    dependencies.nextAuditRecordId,
    'dependencies.nextAuditRecordId',
  );

  const insertEvent = db.prepare(`
    INSERT INTO schedule_reason_events(
      event_id, contract_version, organization_id, project_id, work_item_id,
      prior_resource_version, committed_resource_version, reason_event_type,
      reason_code, actor_id, occurred_at, observed_at, authorization_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertApproval = db.prepare(`
    INSERT INTO schedule_reason_event_approval_records(
      event_id, approval_id, approver_id, approval_authorization_id
    ) VALUES(?,?,?,?)
  `);
  const insertAudit = db.prepare(`
    INSERT INTO schedule_reason_event_audit_records(
      audit_record_id, event_id, action_type
    ) VALUES(?,?,'schedule_reason.recorded')
  `);

  return Object.freeze({
    /**
     * Atomically advance the authoritative work-item version and persist the
     * already-authorized reason event plus immutable audit evidence.
     */
    async commitReasonEvent(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new TypeError('commit request must be an object');
      }
      const event = normalizeEvent(request.event);
      const expectedResourceVersion = requireText(
        request.expectedResourceVersion,
        'expectedResourceVersion',
      );
      if (expectedResourceVersion !== event.expectedWorkItemVersion) {
        throw new Error('commit resource version does not match event authorization version');
      }

      return withSavepoint(db, () => {
        const transition = advanceResourceVersion({
          organizationId: event.organizationId,
          projectId: event.projectId,
          workItemId: event.workItemId,
          expectedResourceVersion,
        });
        if (!transition || transition.advanced !== true) {
          throw new Error('schedule reason event resource version is stale');
        }
        const resourceVersion = requireText(
          transition.resourceVersion,
          'version transition resourceVersion',
        );
        if (resourceVersion === expectedResourceVersion) {
          throw new Error('version transition must advance the resource version');
        }
        const auditRecordId = requireText(nextAuditRecordId(), 'generated auditRecordId');

        insertEvent.run(
          event.eventId,
          event.contractVersion,
          event.organizationId,
          event.projectId,
          event.workItemId,
          event.expectedWorkItemVersion,
          resourceVersion,
          event.type,
          event.reasonCode,
          event.actorId,
          event.occurredAt,
          event.observedAt,
          event.authorizationId,
        );
        if (event.approvalId !== null) {
          insertApproval.run(
            event.eventId,
            event.approvalId,
            event.approverId,
            event.approvalAuthorizationId,
          );
        }
        insertAudit.run(auditRecordId, event.eventId);

        return Object.freeze({
          committed: true,
          eventId: event.eventId,
          auditRecordId,
          resourceVersion,
        });
      });
    },
  });
}
