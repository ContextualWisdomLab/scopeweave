import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { randomBytes } from 'node:crypto';
import { app as coreApp } from './app.mjs';
import { db } from './db.mjs';
import {
  CalendarSubscriptionError,
  createCalendarSubscriptionService,
} from './calendar_subscription_domain.mjs';
import {
  createSqliteCalendarSubscriptionRepository,
  installCalendarSubscriptionSchema,
} from './calendar_subscription_sqlite.mjs';

const MANAGER_ROLES = new Set(['owner', 'admin']);
const CALENDAR_QUERY_PARAMETER = 'subscription';
const CALENDAR_CONTENT_LINE_MAX_OCTETS = 75;
const CALENDAR_MANAGEMENT_BODY_MAX_BYTES = 4 * 1024;
const PRIVATE_NO_STORE_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
});

installCalendarSubscriptionSchema(db);
db.exec(`
  CREATE TRIGGER IF NOT EXISTS calendar_subscription_membership_revoke_trigger
  BEFORE DELETE ON memberships
  BEGIN
    INSERT INTO calendar_subscription_audit_outbox(
      subscription_id, event_type, subject_id, project_id, occurred_at_ms, delivered_at_ms
    )
    SELECT subscription_id,
           'revoked',
           subject_id,
           project_id,
           MAX(created_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
           NULL
      FROM calendar_subscriptions
     WHERE subject_id = OLD.user_id
       AND project_id IN (SELECT id FROM projects WHERE org_id = OLD.org_id)
       AND revoked_at_ms IS NULL;

    UPDATE calendar_subscriptions
       SET revoked_at_ms = MAX(created_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
     WHERE subject_id = OLD.user_id
       AND project_id IN (SELECT id FROM projects WHERE org_id = OLD.org_id)
       AND revoked_at_ms IS NULL;
  END;
`);

function projectMembership(subjectId, projectId) {
  return db.prepare(`
    SELECT p.id AS project_id, p.org_id, p.name, p.tasks_json, m.id AS membership_id,
           m.role, u.token_version
      FROM projects p
      JOIN memberships m ON m.org_id = p.org_id
      JOIN users u ON u.id = m.user_id
     WHERE p.id = ? AND m.user_id = ?
  `).get(projectId, subjectId);
}

const projectAuthorization = Object.freeze({
  /** Require owner/admin authority without disclosing inaccessible projects. */
  async assertCanManage({ subjectId, projectId }) {
    const row = projectMembership(subjectId, projectId);
    if (!row || !MANAGER_ROLES.has(row.role)) throw new Error('calendar_subscription_project_not_manageable');
  },
});

const membershipRevocation = Object.freeze({
  /** Return the same membership/session epoch enforced by the SQLite adapter. */
  async assertActive({ subjectId, projectId }) {
    const row = projectMembership(subjectId, projectId);
    if (!row) throw new Error('calendar_subscription_membership_inactive');
    return `${row.membership_id}:${row.token_version}`;
  },
});

const auditSink = Object.freeze({
  /** Mirror secret-free lifecycle metadata into the existing append-only audit log. */
  async record(event) {
    const row = db.prepare('SELECT org_id FROM projects WHERE id = ?').get(event.project_id);
    if (!row) return;
    db.prepare(`
      INSERT INTO audit_log(org_id,user_id,action,target_type,target_id,meta)
      VALUES(?,?,?,?,?,?)
    `).run(
      row.org_id,
      event.subject_id,
      event.event,
      'calendar_subscription',
      event.subscription_id,
      JSON.stringify({
        project_id: event.project_id,
        purpose: event.purpose,
        audience: event.audience,
        expires_at_ms: event.expires_at_ms ?? null,
      }),
    );
  },
});

const calendarSubscriptionService = createCalendarSubscriptionService({
  repository: createSqliteCalendarSubscriptionRepository(db),
  clock: { nowMs: () => Date.now() },
  randomSource: { randomBytes: (size) => randomBytes(size) },
  auditSink,
  projectAuthorization,
  membershipRevocation,
});

const calendarManagementBodyLimit = bodyLimit({
  maxSize: CALENDAR_MANAGEMENT_BODY_MAX_BYTES,
  onError: (c) => c.json(
    { error: 'calendar_subscription_body_too_large' },
    413,
    { 'Cache-Control': 'no-store' },
  ),
});

async function authenticatedUserFromAuthorization(authorization) {
  if (!authorization) return null;
  const response = await coreApp.request('/api/me', { headers: { authorization } });
  if (!response.ok) return null;
  const payload = await response.json();
  return payload?.user?.id == null ? null : payload.user;
}

async function authenticatedUser(c) {
  return authenticatedUserFromAuthorization(c.req.header('authorization') || '');
}

function noStoreJson(c, payload, status = 200) {
  return c.json(payload, status, { 'Cache-Control': 'no-store' });
}

function calendarUnauthorized(c) {
  return c.json({ error: 'calendar_subscription_unauthorized' }, 401, PRIVATE_NO_STORE_HEADERS);
}

async function calendarOperation(c, operation, successStatus = 200) {
  const user = await authenticatedUser(c);
  if (!user) return noStoreJson(c, { error: 'unauthorized' }, 401);
  try {
    return noStoreJson(c, await operation(String(user.id)), successStatus);
  } catch (error) {
    if (error instanceof CalendarSubscriptionError) {
      return noStoreJson(c, { error: error.code }, error.status);
    }
    throw error;
  }
}

function escapeCalendarText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/[,;]/g, (match) => `\\${match}`)
    .replace(/\r\n|\r|\n/g, '\\n');
}

function foldCalendarContentLine(line) {
  const segments = [];
  let segment = '';
  let segmentBytes = 0;

  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (segmentBytes + characterBytes > CALENDAR_CONTENT_LINE_MAX_OCTETS) {
      segments.push(segment);
      segment = ' ';
      segmentBytes = 1;
    }
    segment += character;
    segmentBytes += characterBytes;
  }

  segments.push(segment);
  return segments.join('\r\n');
}

function compactCalendarDay(value) {
  return String(value).replaceAll('-', '');
}

function isCalendarDay(value) {
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function nextCalendarDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  const nextDay = date.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(nextDay) ? compactCalendarDay(nextDay) : null;
}

function renderCalendarFeed(project) {
  let tasks = [];
  try {
    tasks = JSON.parse(project.tasks_json);
  } catch {
    tasks = [];
  }
  if (!Array.isArray(tasks)) tasks = [];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ScopeWeave//KO',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeCalendarText(project.name)}`,
  ];
  for (const task of tasks) {
    const startDay = String(task?.plannedStartDate || '');
    const endDay = String(task?.plannedEndDate || '');
    if (
      !isCalendarDay(startDay)
      || !isCalendarDay(endDay)
      || endDay < startDay
    ) continue;
    const exclusiveEnd = nextCalendarDay(endDay);
    if (!exclusiveEnd) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:scopeweave-${project.project_id}-${escapeCalendarText(task.id)}`,
      `DTSTART;VALUE=DATE:${compactCalendarDay(startDay)}`,
      `DTEND;VALUE=DATE:${exclusiveEnd}`,
      `SUMMARY:${escapeCalendarText(task.name || task.task || task.id)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldCalendarContentLine).join('\r\n')}\r\n`;
}

function calendarFeedResponse(c, project) {
  return c.text(renderCalendarFeed(project), 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="scopeweave-${project.project_id}.ics"`,
    ...PRIVATE_NO_STORE_HEADERS,
    'X-Content-Type-Options': 'nosniff',
  });
}

/**
 * Production composition layer. New capability routes are registered before
 * falling through to the legacy/core Hono app so staged migrations can replace
 * one transport at a time without copying the core application.
 */
export const app = new Hono();

app.post(
  '/api/projects/:id/calendar-subscriptions',
  calendarManagementBodyLimit,
  (c) => calendarOperation(c, async (subjectId) => {
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const created = await calendarSubscriptionService.create({
      subjectId,
      projectId,
      name: body.name,
      expiresAtMs: body.expiresAtMs,
    });
    return Object.freeze({
      ...created,
      feedPath: `/api/projects/${encodeURIComponent(projectId)}/calendar.ics?${CALENDAR_QUERY_PARAMETER}=${encodeURIComponent(created.secret)}`,
    });
  }, 201),
);

app.get('/api/projects/:id/calendar-subscriptions', (c) => calendarOperation(c, async (subjectId) => ({
  subscriptions: await calendarSubscriptionService.list({
    subjectId,
    projectId: c.req.param('id'),
  }),
})));

app.post(
  '/api/projects/:id/calendar-subscriptions/:subscriptionId/rotate',
  calendarManagementBodyLimit,
  (c) => calendarOperation(c, async (subjectId) => {
    const body = await c.req.json().catch(() => ({}));
    const rotated = await calendarSubscriptionService.rotate({
      subjectId,
      projectId: c.req.param('id'),
      subscriptionId: c.req.param('subscriptionId'),
      expiresAtMs: body.expiresAtMs,
    });
    return Object.freeze({
      ...rotated,
      feedPath: `/api/projects/${encodeURIComponent(c.req.param('id'))}/calendar.ics?${CALENDAR_QUERY_PARAMETER}=${encodeURIComponent(rotated.secret)}`,
    });
  }),
);

app.delete('/api/projects/:id/calendar-subscriptions/:subscriptionId', (c) => calendarOperation(c, (subjectId) => (
  calendarSubscriptionService.revoke({
    subjectId,
    projectId: c.req.param('id'),
    subscriptionId: c.req.param('subscriptionId'),
  })
)));

app.get('/api/projects/:id/calendar.ics', async (c) => {
  const secret = c.req.query(CALENDAR_QUERY_PARAMETER) || '';
  const queryToken = c.req.query('token') || '';
  const authorization = c.req.header('authorization') || '';
  if (secret) {
    if (queryToken || authorization) return calendarUnauthorized(c);
    try {
      const principal = await calendarSubscriptionService.authorize({
        secret,
        projectId: c.req.param('id'),
      });
      const project = projectMembership(principal.subjectId, principal.projectId);
      return project ? calendarFeedResponse(c, project) : calendarUnauthorized(c);
    } catch (error) {
      if (!(error instanceof CalendarSubscriptionError)) throw error;
      return calendarUnauthorized(c);
    }
  }

  if (queryToken && authorization) return calendarUnauthorized(c);
  const legacyAuthorization = authorization || (queryToken ? `Bearer ${queryToken}` : '');
  const user = await authenticatedUserFromAuthorization(legacyAuthorization);
  if (!user) return calendarUnauthorized(c);
  const project = projectMembership(String(user.id), c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404, PRIVATE_NO_STORE_HEADERS);
  return calendarFeedResponse(c, project);
});

app.all('*', (c) => coreApp.fetch(c.req.raw));
