// ScopeWeave HTTP composition root.
// The established SaaS surface stays in app_core.mjs while bounded domain routes
// are composed here so they can reuse stable domain/persistence adapters.
import { randomBytes } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import { app } from './app_core.mjs';
import { db } from './db.mjs';
import { hashApiToken, verifyToken } from './auth.mjs';
import { recordScheduleReasonEvent } from './schedule_reason_event_domain.mjs';
import {
  createSqliteScheduleReasonEventRepository,
  installScheduleReasonEventSchema,
} from './schedule_reason_event_sqlite.mjs';
import {
  createSqliteScheduleReasonProjectVersionAdapter,
  formatScheduleReasonResourceVersion,
} from './schedule_reason_event_project_version.mjs';

const REASON_ROUTE = '/api/projects/:id/schedule/reasons';
const WRITE_ROLES = new Set(['owner', 'admin', 'member']);
const REASON_ACTIONS = new Set(['schedule_outcome.skip', 'schedule_outcome.not_performed']);

installScheduleReasonEventSchema(db);
const projectVersionPort = createSqliteScheduleReasonProjectVersionAdapter(db);
const reasonRepository = createSqliteScheduleReasonEventRepository(db, {
  advanceResourceVersion: projectVersionPort.advanceResourceVersion,
  nextAuditRecordId: () => `audit_${randomBytes(16).toString('hex')}`,
});

const invalidRequest = (c) => c.json({
  error: 'Schedule reason request is invalid.',
  code: 'schedule_reason_invalid_request',
  action: 'Use skipped or not_performed with the current project version and a valid work item.',
}, 400);

const versionConflict = (c) => c.json({
  error: 'Project version changed. Refresh the plan before recording this reason.',
  code: 'schedule_reason_version_conflict',
  action: 'Refresh the project and retry against the current version.',
}, 409);

/** Authenticate the schedule write with the same JWT/PAT authority as core API routes. */
async function requireScheduleAuth(c, next) {
  const header = c.req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token.startsWith('swk_')) {
    const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hashApiToken(token));
    if (!row) return c.json({ error: 'unauthorized' }, 401);
    db.prepare("UPDATE api_tokens SET last_used = datetime('now') WHERE id = ?").run(row.id);
    c.set('scheduleUserId', row.user_id);
    return next();
  }
  try {
    const payload = verifyToken(token);
    const user = db.prepare('SELECT token_version FROM users WHERE id = ?').get(payload.sub);
    if (!user || (payload.tv || 0) !== user.token_version) return c.json({ error: 'unauthorized' }, 401);
    c.set('scheduleUserId', payload.sub);
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
}

/** Fetch one project only when the authenticated user belongs to its tenant. */
function scheduleProjectAccess(userId, projectId) {
  return db.prepare(
    `SELECT p.*, m.role AS memberRole FROM projects p
     JOIN memberships m ON m.org_id = p.org_id
     WHERE p.id = ? AND m.user_id = ?`,
  ).get(projectId, userId);
}

/** Confirm the exact work-item identity once before user-facing validation. */
function hasExactlyOneWorkItem(tasksJson, workItemId) {
  const tasks = JSON.parse(tasksJson);
  if (!Array.isArray(tasks)) throw new Error('stored project tasks are invalid');
  return tasks.filter(
    (task) => task && typeof task === 'object' && !Array.isArray(task) && task.id === workItemId,
  ).length === 1;
}

app.post(
  REASON_ROUTE,
  requireScheduleAuth,
  bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => c.json({
      error: 'Schedule reason request is too large.',
      code: 'schedule_reason_request_too_large',
      action: 'Send only the work item, reason, occurrence time, and current project version.',
    }, 413),
  }),
  async (c) => {
    const userId = c.get('scheduleUserId');
    const project = scheduleProjectAccess(userId, c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!WRITE_ROLES.has(project.memberRole)) return c.json({ error: 'forbidden: viewer role is read-only' }, 403);

    const body = await c.req.json().catch(() => null);
    if (
      !body
      || typeof body !== 'object'
      || Array.isArray(body)
      || !Number.isSafeInteger(body.version)
      || body.version < 1
    ) return invalidRequest(c);
    if (body.version !== project.version) return versionConflict(c);
    if (body.type === 'cancelled') {
      return c.json({
        error: 'Cancellation requires durable approval from a different authorized user.',
        code: 'schedule_reason_cancellation_approval_required',
        action: 'Ask an owner or admin other than the acting user to record approval, then retry.',
      }, 409);
    }
    if (!['skipped', 'not_performed'].includes(body.type)) return invalidRequest(c);
    if (!hasExactlyOneWorkItem(project.tasks_json, body.workItemId)) return invalidRequest(c);

    const organizationId = String(project.org_id);
    const projectId = String(project.id);
    const actorId = String(userId);
    const expectedResourceVersion = formatScheduleReasonResourceVersion(project.version);
    const authorizationPort = Object.freeze({
      authorize: async (request) => ({
        allowed: request.organizationId === organizationId
          && request.projectId === projectId
          && request.actorId === actorId
          && request.expectedResourceVersion === expectedResourceVersion
          && request.workItemId === body.workItemId
          && REASON_ACTIONS.has(request.action),
        authorizationId: `authz_${randomBytes(16).toString('hex')}`,
        resourceVersion: expectedResourceVersion,
      }),
    });

    try {
      const result = await recordScheduleReasonEvent({
        organizationId,
        projectId,
        workItemId: body.workItemId,
        actorId,
        expectedWorkItemVersion: expectedResourceVersion,
        type: body.type,
        reasonCode: body.reasonCode,
        occurredAt: body.occurredAt,
        approvalRef: null,
      }, {
        clock: { now: () => new Date().toISOString() },
        randomSource: { nextOpaqueId: () => `evt_${randomBytes(16).toString('hex')}` },
        authorizationPort,
        approvalPort: { verifyCancellationApproval: async () => ({ valid: false }) },
        repositoryPort: reasonRepository,
      });
      return c.json({
        eventId: result.event.eventId,
        auditRecordId: result.receipt.auditRecordId,
        type: result.event.type,
        workItemId: result.event.workItemId,
        projectVersion: project.version + 1,
      }, 201, { 'Cache-Control': 'no-store' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('resource version is stale')) return versionConflict(c);
      if (error instanceof TypeError || message === 'occurredAt cannot be after the trusted clock') {
        return invalidRequest(c);
      }
      if (message === 'schedule reason event authorization denied') {
        return c.json({ error: 'forbidden' }, 403);
      }
      throw error;
    }
  },
);

export { app };
