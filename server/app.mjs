// ScopeWeave SaaS API. Multi-tenant (org-scoped), optimistic concurrency on
// project docs, SSE realtime fan-out per project. The existing static client
// (index.html/app.js) becomes the frontend that talks to these routes.
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHmac, createHash } from 'node:crypto';
import { db, rowid } from './db.mjs';
import { hashPassword, verifyPassword, signToken, verifyToken, generateApiToken, hashApiToken } from './auth.mjs';
import { PLANS, planOf, orgUsage, wouldExceed, createCheckout } from './billing.mjs';
import { clearfolioMock, mockArtifact, submitJob, jobStatus, artifactUrl } from './clearfolio.mjs';
import { normalizeAttachmentStatusBudgetMs, normalizeAttachmentStatusConcurrency, normalizeAttachmentStatusTimeoutMs, refreshAttachmentStatuses } from './attachment_status.mjs';
import { chat as orchestratorChat } from './orchestrator.mjs';
import { computeEvm } from '../analytics.js'; // pure math, shared with the client

const getOrg = (id) => db.prepare('SELECT * FROM orgs WHERE id = ?').get(id);

// Append-only audit trail. Never throws into the request path.
function logAudit(orgId, userId, action, targetType, targetId, meta) {
  try {
    db.prepare('INSERT INTO audit_log(org_id,user_id,action,target_type,target_id,meta) VALUES(?,?,?,?,?,?)')
      .run(orgId, userId ?? null, action, targetType ?? null, targetId != null ? String(targetId) : null, meta ? JSON.stringify(meta) : null);
  } catch { /* audit must not break the operation */ }
}

// --- RBAC. Roles (highest→lowest): owner > admin > member > viewer.
const orgRole = (userId, orgId) =>
  db.prepare('SELECT role FROM memberships WHERE user_id = ? AND org_id = ?').get(userId, orgId)?.role || null;
const canManage = (role) => role === 'owner' || role === 'admin';
const canWrite = (role) => role === 'owner' || role === 'admin' || role === 'member';

export const app = new Hono();

async function requireAuth(c, next) {
  const header = c.req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Personal Access Token path (swk_...): look up by hash, act as its user.
  if (token.startsWith('swk_')) {
    const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hashApiToken(token));
    if (!row) return c.json({ error: 'unauthorized' }, 401);
    db.prepare("UPDATE api_tokens SET last_used = datetime('now') WHERE id = ?").run(row.id);
    c.set('user', { sub: row.user_id, viaPat: true });
    return next();
  }
  try {
    const payload = verifyToken(token);
    // Session revocation: a bumped token_version invalidates all older JWTs.
    const u = db.prepare('SELECT token_version FROM users WHERE id = ?').get(payload.sub);
    if (!u || (payload.tv || 0) !== u.token_version) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', payload);
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
}

// --- realtime: projectId -> Set<ReadableStreamController>
const streams = new Map();
function broadcast(projectId, data) {
  const subs = streams.get(String(projectId));
  if (!subs) return;
  const chunk = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  for (const ctrl of subs) {
    try { ctrl.enqueue(chunk); } catch { /* dropped subscriber */ }
  }
}

// Membership-scoped project fetch — the tenant isolation boundary.
function projectAccess(userId, projectId) {
  return db.prepare(
    `SELECT p.*, m.role AS memberRole FROM projects p
     JOIN memberships m ON m.org_id = p.org_id
     WHERE p.id = ? AND m.user_id = ?`
  ).get(projectId, userId);
}

// --- observability: in-process counters + structured request log.
const metrics = {
  startedAt: new Date().toISOString(),
  requests: 0,
  s2xx: 0,
  s4xx: 0,
  s5xx: 0,
  signups: 0,
  projectsCreated: 0,
  webhookDeliveries: 0,
  attachmentStatusRefreshAttempted: 0,
  attachmentStatusRefreshChanged: 0,
  attachmentStatusRefreshFailed: 0,
  attachmentStatusRefreshDeferred: 0,
};

// Outbound webhooks: POST signed JSON to each active hook subscribed to `event`.
// Fire-and-forget with a timeout, one retry on failure, and a recorded outcome
// per attempt — never blocks or fails the triggering request.
function recordDelivery(webhookId, event, status, ok, attempt) {
  try {
    db.prepare('INSERT INTO webhook_deliveries(webhook_id,event,status_code,ok,attempt) VALUES(?,?,?,?,?)')
      .run(webhookId, event, status ?? null, ok ? 1 : 0, attempt);
  } catch { /* recording must not break delivery */ }
}

function sendWebhook(webhookId, url, sig, event, body, attempt) {
  metrics.webhookDeliveries++;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 3000);
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-scopeweave-event': event, 'x-scopeweave-signature': `sha256=${sig}` },
    body,
    signal: ctrl.signal,
  }).then((res) => {
    recordDelivery(webhookId, event, res.status, res.ok, attempt);
    if (!res.ok && attempt < 2) setTimeout(() => sendWebhook(webhookId, url, sig, event, body, attempt + 1), 500);
  }).catch(() => {
    recordDelivery(webhookId, event, null, false, attempt);
    if (attempt < 2) setTimeout(() => sendWebhook(webhookId, url, sig, event, body, attempt + 1), 500);
  }).finally(() => clearTimeout(to));
}

function deliver(orgId, event, payload) {
  let hooks;
  try {
    hooks = db.prepare('SELECT id, url, secret, events FROM webhooks WHERE org_id = ? AND active = 1').all(orgId);
  } catch { return; }
  for (const h of hooks) {
    const subs = String(h.events || '').split(',').map((s) => s.trim());
    if (!(subs.includes('*') || subs.includes(event))) continue;
    const body = JSON.stringify({ event, orgId: Number(orgId), payload, ts: new Date().toISOString() });
    const sig = createHmac('sha256', h.secret).update(body).digest('hex');
    sendWebhook(h.id, h.url, sig, event, body, 1);
  }
}
const quietLogs = String(process.env.SCOPEWEAVE_DB || '').includes(':memory:'); // silence during tests
app.use('*', async (c, next) => {
  const t = Date.now();
  await next();
  try {
    metrics.requests++;
    const s = c.res.status;
    if (s >= 500) metrics.s5xx++; else if (s >= 400) metrics.s4xx++; else if (s >= 200) metrics.s2xx++;
    if (!quietLogs) {
      // structured; never logs bodies, tokens, or secrets
      console.log(JSON.stringify({ ts: new Date().toISOString(), method: c.req.method, path: c.req.path, status: s, ms: Date.now() - t }));
    }
  } catch { /* metrics/logging must never break a request */ }
});

// Rate limiting (opt-in via SCOPEWEAVE_RATE_LIMIT_MAX, per client IP, fixed
// window). Protects against brute-force/abuse. Off by default so it never
// surprises tests/dev. Ceiling: per-instance in-memory → use Redis for multi-node.
const RL_MAX = Number(process.env.SCOPEWEAVE_RATE_LIMIT_MAX) || 0;
const RL_WINDOW_MS = Number(process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS) || 60000;
const rlBuckets = new Map();
if (RL_MAX > 0) {
  app.use('*', async (c, next) => {
    const key = (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'local';
    const now = Date.now();
    let b = rlBuckets.get(key);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + RL_WINDOW_MS }; rlBuckets.set(key, b); }
    b.count++;
    if (b.count > RL_MAX) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      return c.json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': String(retry) });
    }
    await next();
  });
}

app.post('/api/auth/signup', async (c) => {
  const { email, password, name } = await c.req.json().catch(() => ({}));
  if (!email || typeof password !== 'string' || password.length < 8) {
    return c.json({ error: 'email and password (min 8 chars) required' }, 400);
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return c.json({ error: 'email already registered' }, 409);
  }
  // user + personal workspace + owner membership, atomically.
  let uid;
  const tx = () => {
    uid = rowid(db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)')
      .run(email, hashPassword(password), name || ''));
    const oid = rowid(db.prepare('INSERT INTO orgs(name,owner_id) VALUES(?,?)')
      .run(`${name || email}'s workspace`, uid));
    db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(oid, uid, 'owner');
  };
  db.exec('BEGIN');
  try { tx(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  metrics.signups++;
  return c.json({ token: signToken({ sub: uid, email, tv: 0 }) });
});

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email || '');
  // Pass password through only when it is a string — verifyPassword rejects
  // non-strings (objects/arrays) so they never match an empty-password hash.
  if (!u || typeof password !== 'string' || !verifyPassword(password, u.password_hash)) {
    return c.json({ error: 'invalid credentials' }, 401);
  }
  return c.json({ token: signToken({ sub: u.id, email: u.email, tv: u.token_version }) });
});

app.get('/api/me', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const user = db.prepare('SELECT id,email,name FROM users WHERE id = ?').get(uid);
  const orgs = db.prepare(
    `SELECT o.id,o.name,o.plan,m.role FROM orgs o
     JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ?`
  ).all(uid);
  return c.json({ user, orgs });
});

// Create an additional workspace (org); the creator becomes its owner.
app.post('/api/orgs', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const { name } = await c.req.json().catch(() => ({}));
  if (!name || !String(name).trim()) return c.json({ error: 'name required' }, 400);
  let oid;
  db.exec('BEGIN');
  try {
    oid = rowid(db.prepare('INSERT INTO orgs(name,owner_id) VALUES(?,?)').run(String(name).trim().slice(0, 120), uid));
    db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(oid, uid, 'owner');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logAudit(oid, uid, 'org.create', 'org', oid, { name });
  return c.json({ id: oid, name: String(name).trim(), role: 'owner' });
});

app.get('/api/projects', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const projects = db.prepare(
    `SELECT p.id,p.name,p.base_date AS baseDate,p.version,p.org_id AS orgId,p.updated_at AS updatedAt,p.archived
     FROM projects p JOIN memberships m ON m.org_id = p.org_id
     WHERE m.user_id = ? ORDER BY p.archived ASC, p.updated_at DESC`
  ).all(uid);
  return c.json({ projects });
});

app.post('/api/projects', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const { name, orgId } = await c.req.json().catch(() => ({}));
  if (!name) return c.json({ error: 'name required' }, 400);
  const org = orgId
    ? db.prepare('SELECT o.id FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE o.id = ? AND m.user_id = ?').get(orgId, uid)
    : db.prepare('SELECT o.id FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.id LIMIT 1').get(uid);
  if (!org) return c.json({ error: 'no accessible org' }, 400);
  if (wouldExceed(db, getOrg(org.id), 'projects')) {
    return c.json({ error: 'project limit reached on the Free plan', upgrade: true, limit: PLANS.free.limits.projects }, 402);
  }
  const id = rowid(db.prepare('INSERT INTO projects(org_id,name,created_by) VALUES(?,?,?)').run(org.id, name, uid));
  metrics.projectsCreated++;
  logAudit(org.id, uid, 'project.create', 'project', id, { name });
  return c.json({ id, name, version: 1 });
});

app.get('/api/projects/:id', requireAuth, (c) => {
  const p = projectAccess(c.get('user').sub, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  return c.json({ id: p.id, name: p.name, orgId: p.org_id, baseDate: p.base_date, methodology: p.methodology || 'waterfall', tasks: JSON.parse(p.tasks_json), version: p.version });
});

app.put('/api/projects/:id', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const id = c.req.param('id');
  const p = projectAccess(uid, id);
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden: viewer role is read-only' }, 403);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.version === 'number' && body.version !== p.version) {
    return c.json({ error: 'version conflict', current: p.version }, 409);
  }
  const tasks = Array.isArray(body.tasks) ? body.tasks : JSON.parse(p.tasks_json);
  const version = p.version + 1;
  const methodology = ['waterfall', 'agile', 'hybrid'].includes(body.methodology) ? body.methodology : (p.methodology || 'waterfall');
  db.prepare(
    "UPDATE projects SET name=?, base_date=?, tasks_json=?, version=?, methodology=?, updated_at=datetime('now') WHERE id=?"
  ).run(body.name ?? p.name, body.baseDate ?? p.base_date, JSON.stringify(tasks), version, methodology, id);
  logAudit(p.org_id, uid, 'project.update', 'project', id, { version, tasks: tasks.length });
  // Revision history: snapshot every save, keep the last 20 per project.
  try {
    db.prepare('INSERT OR REPLACE INTO project_revisions(project_id,version,name,base_date,tasks_json,saved_by) VALUES(?,?,?,?,?,?)')
      .run(id, version, body.name ?? p.name, body.baseDate ?? p.base_date, JSON.stringify(tasks), uid);
    db.prepare('DELETE FROM project_revisions WHERE project_id = ? AND version <= ?').run(id, version - 20);
  } catch { /* history must not break saves */ }
  deliver(p.org_id, 'project.update', { projectId: Number(id), version, tasks: tasks.length, by: uid });
  broadcast(id, { type: 'update', version, by: uid });
  return c.json({ version });
});

// Task comments: discussion bound to a project (optionally a task). All roles
// can read; write roles can post; author or manage can delete.
app.get('/api/projects/:id/comments', requireAuth, (c) => {
  const p = projectAccess(c.get('user').sub, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  const taskId = c.req.query('taskId');
  const comments = (taskId
    ? db.prepare(`SELECT cm.id, cm.task_id AS taskId, cm.body, cm.created_at AS createdAt, cm.user_id AS userId, u.email
        FROM comments cm LEFT JOIN users u ON u.id = cm.user_id
        WHERE cm.project_id = ? AND cm.task_id = ? ORDER BY cm.id DESC LIMIT 100`).all(p.id, taskId)
    : db.prepare(`SELECT cm.id, cm.task_id AS taskId, cm.body, cm.created_at AS createdAt, cm.user_id AS userId, u.email
        FROM comments cm LEFT JOIN users u ON u.id = cm.user_id
        WHERE cm.project_id = ? ORDER BY cm.id DESC LIMIT 100`).all(p.id));
  return c.json({ comments });
});

app.post('/api/projects/:id/comments', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const { taskId, body } = await c.req.json().catch(() => ({}));
  const text = String(body || '').trim();
  if (!text) return c.json({ error: 'body required' }, 400);
  if (text.length > 2000) return c.json({ error: 'comment too long (max 2000)' }, 400);
  const cid = rowid(db.prepare('INSERT INTO comments(project_id,task_id,user_id,body) VALUES(?,?,?,?)')
    .run(p.id, String(taskId || ''), uid, text));
  logAudit(p.org_id, uid, 'comment.create', 'project', p.id, { commentId: cid, taskId: taskId || null });
  broadcast(p.id, { type: 'comment', commentId: cid, by: uid });
  return c.json({ id: cid });
});

app.delete('/api/projects/:id/comments/:cid', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  const cm = db.prepare('SELECT user_id FROM comments WHERE id = ? AND project_id = ?').get(c.req.param('cid'), p.id);
  if (!cm) return c.json({ error: 'not found' }, 404);
  if (cm.user_id !== uid && !canManage(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.req.param('cid'));
  return c.json({ ok: true });
});

// Revision history: list, inspect, restore.
app.get('/api/projects/:id/revisions', requireAuth, (c) => {
  const p = projectAccess(c.get('user').sub, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  const revisions = db.prepare(
    `SELECT r.version, r.created_at AS savedAt, u.email AS savedBy FROM project_revisions r
     LEFT JOIN users u ON u.id = r.saved_by WHERE r.project_id = ? ORDER BY r.version DESC`
  ).all(p.id);
  return c.json({ revisions });
});

app.get('/api/projects/:id/revisions/:version', requireAuth, (c) => {
  const p = projectAccess(c.get('user').sub, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  const r = db.prepare('SELECT version, name, base_date AS baseDate, tasks_json FROM project_revisions WHERE project_id = ? AND version = ?')
    .get(p.id, c.req.param('version'));
  if (!r) return c.json({ error: 'not found' }, 404);
  return c.json({ version: r.version, name: r.name, baseDate: r.baseDate, tasks: JSON.parse(r.tasks_json) });
});

// Restore = write the old snapshot as a NEW version (history stays linear).
app.post('/api/projects/:id/revisions/:version/restore', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const id = c.req.param('id');
  const p = projectAccess(uid, id);
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const r = db.prepare('SELECT name, base_date, tasks_json FROM project_revisions WHERE project_id = ? AND version = ?')
    .get(id, c.req.param('version'));
  if (!r) return c.json({ error: 'not found' }, 404);
  const version = p.version + 1;
  db.prepare("UPDATE projects SET name=?, base_date=?, tasks_json=?, version=?, updated_at=datetime('now') WHERE id=?")
    .run(r.name, r.base_date, r.tasks_json, version, id);
  try {
    db.prepare('INSERT OR REPLACE INTO project_revisions(project_id,version,name,base_date,tasks_json,saved_by) VALUES(?,?,?,?,?,?)')
      .run(id, version, r.name, r.base_date, r.tasks_json, uid);
  } catch { /* history must not break restore */ }
  logAudit(p.org_id, uid, 'project.restore', 'project', id, { from: Number(c.req.param('version')), version });
  broadcast(id, { type: 'update', version, by: uid });
  return c.json({ version });
});

// iCalendar feed: planned tasks as all-day VEVENTs — subscribable from
// Google/Outlook. Calendar apps can't send headers, so accept ?token= (same
// pattern + ceiling as /stream). PATs work via the Authorization header.
app.get('/api/projects/:id/calendar.ics', (c) => {
  const header = c.req.header('authorization') || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : (c.req.query('token') || '');
  let uid;
  if (raw.startsWith('swk_')) {
    const row = db.prepare('SELECT user_id FROM api_tokens WHERE token_hash = ?').get(hashApiToken(raw));
    if (!row) return c.json({ error: 'unauthorized' }, 401);
    uid = row.user_id;
  } else {
    try { uid = verifyToken(raw).sub; } catch { return c.json({ error: 'unauthorized' }, 401); }
  }
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  let tasks = [];
  try { tasks = JSON.parse(p.tasks_json); } catch { /* empty */ }
  const day = (s) => String(s).replaceAll('-', '');
  const nextDay = (s) => { const d = new Date(s); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10).replaceAll('-', ''); };
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ScopeWeave//KO', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(p.name)}`];
  for (const t of tasks) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.plannedStartDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(t.plannedEndDate || '')) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:scopeweave-${p.id}-${esc(t.id)}`,
      `DTSTART;VALUE=DATE:${day(t.plannedStartDate)}`,
      `DTEND;VALUE=DATE:${nextDay(t.plannedEndDate)}`, // DTEND is exclusive
      `SUMMARY:${esc(t.name || t.task || t.id)}`,
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return c.text(lines.join('\r\n') + '\r\n', 200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="scopeweave-${p.id}.ics"`,
  });
});

app.get('/api/projects/:id/stream', (c) => {
  // EventSource can't send an Authorization header, so accept a query token
  // here only. Ceiling: issue a short-lived stream-scoped token before prod so
  // full JWTs don't land in URLs / access logs.
  const header = c.req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (c.req.query('token') || '');
  let user;
  try { user = verifyToken(token); } catch { return c.json({ error: 'unauthorized' }, 401); }
  const id = c.req.param('id');
  if (!projectAccess(user.sub, id)) return c.json({ error: 'not found' }, 404);
  const key = String(id);
  const stream = new ReadableStream({
    start(controller) {
      if (!streams.has(key)) streams.set(key, new Set());
      streams.get(key).add(controller);
      controller.enqueue(new TextEncoder().encode(': connected\n\n'));
      c.req.raw.signal?.addEventListener('abort', () => {
        streams.get(key)?.delete(controller);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
});

// --------------------------------------------------------------- teams / RBAC
// List members of an org (any member may view the roster).
app.get('/api/orgs/:id/members', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!orgRole(uid, orgId)) return c.json({ error: 'not found' }, 404);
  const members = db.prepare(
    `SELECT u.id, u.email, u.name, m.role FROM memberships m
     JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.id`
  ).all(orgId);
  const invites = db.prepare(
    `SELECT id, email, role, token, created_at AS createdAt FROM invites
     WHERE org_id = ? AND accepted_at IS NULL ORDER BY id DESC`
  ).all(orgId);
  return c.json({ members, invites });
});

// Revoke a pending invite (owner/admin). The token stops working immediately.
app.delete('/api/orgs/:id/invites/:inviteId', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const info = db.prepare('DELETE FROM invites WHERE id = ? AND org_id = ? AND accepted_at IS NULL')
    .run(c.req.param('inviteId'), orgId);
  if (!info.changes) return c.json({ error: 'not found' }, 404);
  logAudit(orgId, uid, 'invite.revoke', 'invite', c.req.param('inviteId'), {});
  return c.json({ ok: true });
});

// Invite by email (owner/admin only). Returns the token (prod: email a link).
app.post('/api/orgs/:id/invites', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  const role = orgRole(uid, orgId);
  if (!role) return c.json({ error: 'not found' }, 404);
  if (!canManage(role)) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const inviteRole = body.role || 'member';
  if (!email) return c.json({ error: 'email required' }, 400);
  if (!['admin', 'member', 'viewer'].includes(inviteRole)) return c.json({ error: 'invalid role' }, 400);
  const token = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO invites(org_id,email,role,token,invited_by) VALUES(?,?,?,?,?)')
    .run(orgId, email, inviteRole, token, uid);
  logAudit(orgId, uid, 'member.invite', 'invite', email, { role: inviteRole });
  return c.json({ token, email, role: inviteRole });
});

// Accept an invite (any authenticated user holding the token). Idempotent.
app.post('/api/invites/:token/accept', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(c.req.param('token'));
  if (!inv || inv.accepted_at) return c.json({ error: 'invalid or used invite' }, 404);
  const existing = orgRole(uid, inv.org_id);
  if (!existing) {
    if (wouldExceed(db, getOrg(inv.org_id), 'members')) {
      return c.json({ error: 'member limit reached on the Free plan', upgrade: true, limit: PLANS.free.limits.members }, 402);
    }
    db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(inv.org_id, uid, inv.role);
    logAudit(inv.org_id, uid, 'member.join', 'user', uid, { role: inv.role });
    deliver(inv.org_id, 'member.join', { userId: uid, role: inv.role });
  }
  db.prepare("UPDATE invites SET accepted_at = datetime('now') WHERE id = ?").run(inv.id);
  return c.json({ orgId: inv.org_id, role: existing || inv.role });
});

// Change a member's role (owner/admin). Cannot touch an owner or set owner.
app.patch('/api/orgs/:id/members/:userId', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  const targetId = c.req.param('userId');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const newRole = body.role;
  if (!['admin', 'member', 'viewer'].includes(newRole)) return c.json({ error: 'invalid role' }, 400);
  const target = db.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, targetId);
  if (!target) return c.json({ error: 'not found' }, 404);
  if (target.role === 'owner') return c.json({ error: 'cannot change owner role' }, 403);
  db.prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?').run(newRole, orgId, targetId);
  logAudit(orgId, uid, 'member.role_change', 'user', targetId, { from: target.role, to: newRole });
  return c.json({ userId: Number(targetId), role: newRole });
});

// Remove a member (owner/admin). Cannot remove an owner.
app.delete('/api/orgs/:id/members/:userId', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  const targetId = c.req.param('userId');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const target = db.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, targetId);
  if (!target) return c.json({ error: 'not found' }, 404);
  if (target.role === 'owner') return c.json({ error: 'cannot remove owner' }, 403);
  db.prepare('DELETE FROM memberships WHERE org_id = ? AND user_id = ?').run(orgId, targetId);
  logAudit(orgId, uid, 'member.remove', 'user', targetId, { role: target.role });
  return c.json({ ok: true });
});

// Leave a workspace voluntarily (any non-owner member). Owners must transfer or
// delete the org instead — an org can never be left ownerless.
app.post('/api/orgs/:id/leave', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  const role = orgRole(uid, orgId);
  if (!role) return c.json({ error: 'not found' }, 404);
  if (role === 'owner') return c.json({ error: 'owner cannot leave; delete the workspace or transfer ownership' }, 403);
  db.prepare('DELETE FROM memberships WHERE org_id = ? AND user_id = ?').run(orgId, uid);
  logAudit(orgId, uid, 'member.leave', 'user', uid, { role });
  return c.json({ ok: true });
});

// Transfer workspace ownership to an existing member (owner only). The old
// owner becomes an admin; orgs.owner_id follows. Transactional.
app.post('/api/orgs/:id/transfer', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (orgRole(uid, orgId) !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const { userId } = await c.req.json().catch(() => ({}));
  if (!userId || Number(userId) === Number(uid)) return c.json({ error: 'target member userId required' }, 400);
  const target = db.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, userId);
  if (!target) return c.json({ error: 'target is not a member' }, 404);
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE memberships SET role = 'owner' WHERE org_id = ? AND user_id = ?").run(orgId, userId);
    db.prepare("UPDATE memberships SET role = 'admin' WHERE org_id = ? AND user_id = ?").run(orgId, uid);
    db.prepare('UPDATE orgs SET owner_id = ? WHERE id = ?').run(userId, orgId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logAudit(orgId, uid, 'org.transfer', 'user', userId, { from: uid });
  return c.json({ ok: true, newOwnerId: Number(userId) });
});

// Rename a workspace (owner only).
app.patch('/api/orgs/:id', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (orgRole(uid, orgId) !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const { name } = await c.req.json().catch(() => ({}));
  if (!name || !String(name).trim()) return c.json({ error: 'name required' }, 400);
  db.prepare('UPDATE orgs SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 120), orgId);
  logAudit(orgId, uid, 'org.rename', 'org', orgId, { name });
  return c.json({ id: Number(orgId), name: String(name).trim() });
});

// ------------------------------------------------------------------- billing
app.get('/api/orgs/:id/billing', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!orgRole(uid, orgId)) return c.json({ error: 'not found' }, 404);
  const org = getOrg(orgId);
  const plan = planOf(org);
  return c.json({ plan: org.plan, planName: plan.name, priceKrw: plan.priceKrw, limits: plan.limits, usage: orgUsage(db, orgId) });
});

app.post('/api/orgs/:id/checkout', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (orgRole(uid, orgId) !== 'owner') return c.json({ error: 'only the owner can upgrade' }, 403);
  const origin = new URL(c.req.url).origin;
  const session = await createCheckout({ orgId, origin });
  return c.json(session);
});

// Stripe webhook (stub). Live mode should verify the signature with
// STRIPE_WEBHOOK_SECRET before trusting the event — named ceiling.
app.post('/api/stripe/webhook', async (c) => {
  const event = await c.req.json().catch(() => ({}));
  if (event?.type === 'checkout.session.completed') {
    const orgId = event.data?.object?.client_reference_id || event.data?.object?.metadata?.orgId;
    if (orgId) db.prepare("UPDATE orgs SET plan = 'pro' WHERE id = ?").run(orgId);
  }
  return c.json({ received: true });
});

// Dev-only: simulate a successful checkout upgrading the org to Pro.
// Disabled unless SCOPEWEAVE_DEV=1 (never reachable in production).
app.post('/api/orgs/:id/_dev/activate-pro', requireAuth, (c) => {
  if (process.env.SCOPEWEAVE_DEV !== '1') return c.json({ error: 'not found' }, 404);
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (orgRole(uid, orgId) !== 'owner') return c.json({ error: 'forbidden' }, 403);
  db.prepare("UPDATE orgs SET plan = 'pro' WHERE id = ?").run(orgId);
  logAudit(orgId, uid, 'billing.upgrade', 'org', orgId, { plan: 'pro', via: 'dev' });
  deliver(orgId, 'billing.upgrade', { plan: 'pro' });
  return c.json({ plan: 'pro' });
});

// ------------------------------------------------- personal access tokens (PAT)
app.get('/api/tokens', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const tokens = db.prepare(
    'SELECT id, name, prefix, last_used AS lastUsed, created_at AS createdAt FROM api_tokens WHERE user_id = ? ORDER BY id DESC'
  ).all(uid);
  return c.json({ tokens }); // never the secret or hash
});

app.post('/api/tokens', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const { name } = await c.req.json().catch(() => ({}));
  const t = generateApiToken();
  const id = rowid(db.prepare('INSERT INTO api_tokens(user_id,name,token_hash,prefix) VALUES(?,?,?,?)')
    .run(uid, String(name || 'token').slice(0, 60), t.hash, t.prefix));
  // Full secret returned ONCE — never retrievable again.
  return c.json({ id, name: name || 'token', prefix: t.prefix, token: t.full });
});

app.delete('/api/tokens/:id', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const info = db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(c.req.param('id'), uid);
  if (!info.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// Audit trail — owner/admin only. Enterprise requirement.
app.get('/api/orgs/:id/audit', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
  const rows = db.prepare(
    `SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId, a.meta,
            a.created_at AS createdAt, u.email AS actorEmail
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.org_id = ? ORDER BY a.id DESC LIMIT ?`
  ).all(orgId, limit);
  const events = rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
  if (c.req.query('format') === 'csv') {
    // Compliance deliverable. Formula-injection-safe: values that (after optional
    // leading whitespace) start with = + - @ | are prefixed with ' so
    // spreadsheets treat them as text. Leading whitespace alone used to bypass
    // /^[=+\-@|]/ — match the client-side CSV_FORMULA_PREFIX_PATTERN.
    const csvCell = (v) => {
      let s = v == null ? '' : String(v);
      if (/^\s*[=+\-@|]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['id', 'createdAt', 'actorEmail', 'action', 'targetType', 'targetId', 'meta'];
    const lines = [header.join(',')];
    for (const e of events) {
      lines.push([e.id, e.createdAt, e.actorEmail, e.action, e.targetType, e.targetId, e.meta ? JSON.stringify(e.meta) : ''].map(csvCell).join(','));
    }
    return c.text(lines.join('\r\n') + '\r\n', 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="scopeweave-audit-${orgId}.csv"`,
    });
  }
  return c.json({ events });
});

// Full workspace export (owner only) — data portability / GDPR. Everything the
// org holds, as one JSON document.
app.get('/api/orgs/:id/export', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (orgRole(uid, orgId) !== 'owner') return c.json({ error: 'only the owner can export' }, 403);
  const org = getOrg(orgId);
  const members = db.prepare(
    `SELECT u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?`
  ).all(orgId);
  const projects = db.prepare(
    'SELECT id, name, base_date AS baseDate, tasks_json, version, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE org_id = ?'
  ).all(orgId).map((p) => ({ ...p, tasks: JSON.parse(p.tasks_json), tasks_json: undefined }));
  const audit = db.prepare(
    'SELECT action, target_type AS targetType, target_id AS targetId, meta, created_at AS createdAt FROM audit_log WHERE org_id = ? ORDER BY id'
  ).all(orgId).map((a) => ({ ...a, meta: a.meta ? JSON.parse(a.meta) : null }));
  logAudit(orgId, uid, 'org.export', 'org', orgId, { projects: projects.length });
  return c.json({
    exportedAt: new Date().toISOString(),
    org: { id: org.id, name: org.name, plan: org.plan },
    members, projects, audit,
  }, 200, { 'Content-Disposition': `attachment; filename="scopeweave-org-${orgId}.json"` });
});

// Operational metrics (JSON). Ceiling: expose Prometheus text format + gate
// behind an internal token before prod if scraped externally.
app.get('/api/metrics', (c) => {
  const sseActive = [...streams.values()].reduce((n, s) => n + s.size, 0);
  const all = { ...metrics, sseActive, uptimeSec: Math.round(process.uptime()) };
  if (c.req.query('format') !== 'prometheus') return c.json(all);
  // Prometheus text exposition format (0.0.4) — scrape-ready for Grafana/Alerting.
  const gauge = new Set(['sseActive', 'uptimeSec']);
  const lines = [];
  for (const [k, v] of Object.entries(all)) {
    if (typeof v !== 'number') continue; // startedAt etc.
    const name = `scopeweave_${k.replace(/([A-Z])/g, '_$1').toLowerCase()}`;
    lines.push(`# TYPE ${name} ${gauge.has(k) ? 'gauge' : 'counter'}`, `${name} ${v}`);
  }
  return c.text(lines.join('\n') + '\n', 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
});

// ------------------------------------------------------------------- webhooks
app.get('/api/orgs/:id/webhooks', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const webhooks = db.prepare(
    `SELECT w.id, w.url, w.events, w.active, w.created_at AS createdAt,
       (SELECT ok FROM webhook_deliveries d WHERE d.webhook_id = w.id ORDER BY d.id DESC LIMIT 1) AS lastOk,
       (SELECT created_at FROM webhook_deliveries d WHERE d.webhook_id = w.id ORDER BY d.id DESC LIMIT 1) AS lastAt
     FROM webhooks w WHERE w.org_id = ? ORDER BY w.id DESC`
  ).all(orgId); // secret never returned
  return c.json({ webhooks });
});

app.post('/api/orgs/:id/webhooks', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const { url, events } = await c.req.json().catch(() => ({}));
  if (!/^https?:\/\//.test(String(url || ''))) return c.json({ error: 'valid http(s) url required' }, 400);
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const evs = Array.isArray(events) ? events.join(',') : (events || '*');
  const id = rowid(db.prepare('INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)').run(orgId, url, secret, evs));
  logAudit(orgId, uid, 'webhook.create', 'webhook', id, { url, events: evs });
  return c.json({ id, url, events: evs, secret }); // secret shown once for signature verification
});

app.get('/api/orgs/:id/webhooks/:whId/deliveries', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const wh = db.prepare('SELECT id FROM webhooks WHERE id = ? AND org_id = ?').get(c.req.param('whId'), orgId);
  if (!wh) return c.json({ error: 'not found' }, 404);
  const deliveries = db.prepare(
    'SELECT event, status_code AS statusCode, ok, attempt, created_at AS createdAt FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 50'
  ).all(wh.id);
  return c.json({ deliveries });
});

// Rotate a webhook's signing secret (leak response / periodic hygiene). The new
// secret is returned ONCE; old signatures stop validating immediately.
app.post('/api/orgs/:id/webhooks/:whId/rotate', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const info = db.prepare('UPDATE webhooks SET secret = ? WHERE id = ? AND org_id = ?').run(secret, c.req.param('whId'), orgId);
  if (!info.changes) return c.json({ error: 'not found' }, 404);
  logAudit(orgId, uid, 'webhook.rotate', 'webhook', c.req.param('whId'), {});
  return c.json({ id: Number(c.req.param('whId')), secret }); // shown once
});

app.delete('/api/orgs/:id/webhooks/:whId', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const info = db.prepare('DELETE FROM webhooks WHERE id = ? AND org_id = ?').run(c.req.param('whId'), orgId);
  if (!info.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// ------------------------------------------------------------ SSO (OIDC)
// Real IdP via env (OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI). When
// unset, a built-in mock provider makes the whole flow self-contained + testable.
const OIDC = {
  issuer: process.env.OIDC_ISSUER,
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
  redirectUri: process.env.OIDC_REDIRECT_URI,
};
const oidcMock = !OIDC.issuer;
const oidcStates = new Map(); // state -> { verifier, exp }
const oidcCodes = new Map();  // mock only: code -> email

function upsertSsoUser(email) {
  let user = db.prepare('SELECT id, email, token_version FROM users WHERE email = ?').get(email);
  if (user) return user;
  db.exec('BEGIN');
  try {
    const uid = rowid(db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)')
      .run(email, hashPassword(randomBytes(24).toString('hex')), ''));
    const oid = rowid(db.prepare('INSERT INTO orgs(name,owner_id) VALUES(?,?)').run(`${email}'s workspace`, uid));
    db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(oid, uid, 'owner');
    db.exec('COMMIT');
    metrics.signups++;
    return { id: uid, email };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

app.get('/api/auth/oidc/start', (c) => {
  const origin = new URL(c.req.url).origin;
  const state = randomBytes(16).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  oidcStates.set(state, { verifier, exp: Date.now() + 5 * 60 * 1000 });
  const redirectUri = OIDC.redirectUri || `${origin}/api/auth/oidc/callback`;
  if (oidcMock) {
    const email = c.req.query('email') || 'sso-user@example.com';
    const u = new URL(`${origin}/api/auth/oidc/mock/authorize`);
    u.searchParams.set('state', state);
    u.searchParams.set('email', email);
    u.searchParams.set('redirect_uri', redirectUri);
    return c.redirect(u.toString());
  }
  const u = new URL(`${OIDC.issuer.replace(/\/$/, '')}/authorize`);
  u.searchParams.set('client_id', OIDC.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return c.redirect(u.toString());
});

// Built-in mock IdP authorize — instantly issues a code (dev/test only).
app.get('/api/auth/oidc/mock/authorize', (c) => {
  if (!oidcMock) return c.json({ error: 'mock disabled' }, 404);
  const state = c.req.query('state');
  const email = c.req.query('email');
  const redirectUri = c.req.query('redirect_uri');
  const code = randomBytes(16).toString('hex');
  oidcCodes.set(code, email);
  const u = new URL(redirectUri);
  u.searchParams.set('code', code);
  u.searchParams.set('state', state);
  return c.redirect(u.toString());
});

app.get('/api/auth/oidc/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  const s = oidcStates.get(state);
  if (!s || s.exp < Date.now()) return c.json({ error: 'invalid or expired state' }, 400);
  oidcStates.delete(state);
  let email;
  if (oidcMock) {
    email = oidcCodes.get(code);
    oidcCodes.delete(code);
    if (!email) return c.json({ error: 'invalid code' }, 400);
  } else {
    const redirectUri = OIDC.redirectUri || `${new URL(c.req.url).origin}/api/auth/oidc/callback`;
    const tokenRes = await fetch(`${OIDC.issuer.replace(/\/$/, '')}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: OIDC.clientId, client_secret: OIDC.clientSecret, code_verifier: s.verifier }),
    }).catch(() => null);
    const tok = tokenRes ? await tokenRes.json().catch(() => ({})) : {};
    if (!tok.id_token) return c.json({ error: 'token exchange failed' }, 400);
    // Ceiling: verify the id_token signature via the issuer JWKS before prod.
    const claims = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1] || '', 'base64url').toString() || '{}');
    email = claims.email;
    if (!email) return c.json({ error: 'no email claim' }, 400);
  }
  const user = upsertSsoUser(email);
  const token = signToken({ sub: user.id, email, tv: user.token_version || 0 });
  // Return the token in the URL fragment (not query → not logged); the client
  // stores it and cleans the URL.
  return c.redirect(`/#token=${token}`);
});

// Cross-project search: project names + task names, membership-scoped (tenant
// isolation via the same JOIN as projectAccess).
// ponytail: LIKE over tasks_json text; move to FTS5 if search gets heavy.
app.get('/api/search', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const q = String(c.req.query('q') || '').trim();
  if (q.length < 2) return c.json({ error: 'query too short (min 2)' }, 400);
  const rows = db.prepare(
    `SELECT DISTINCT p.id, p.name, p.tasks_json FROM projects p
     JOIN memberships m ON m.org_id = p.org_id
     WHERE m.user_id = ? AND (p.name LIKE ? OR p.tasks_json LIKE ?) LIMIT 100`
  ).all(uid, `%${q}%`, `%${q}%`);
  const needle = q.toLowerCase();
  const results = [];
  for (const p of rows) {
    const hit = { projectId: p.id, projectName: p.name, tasks: [] };
    if (p.name.toLowerCase().includes(needle)) hit.nameMatch = true;
    let tasks = [];
    try { tasks = JSON.parse(p.tasks_json); } catch { /* skip bad json */ }
    for (const t of tasks) {
      if (String(t.name || '').toLowerCase().includes(needle)) {
        hit.tasks.push({ id: t.id, name: t.name });
        if (hit.tasks.length >= 5) break;
      }
    }
    if (hit.nameMatch || hit.tasks.length) results.push(hit);
    if (results.length >= 20) break;
  }
  return c.json({ query: q, results });
});

// Portfolio dashboard: executive rollup across every project in a workspace —
// weighted planned/actual progress, SPI + status, overdue-task counts.
app.get('/api/orgs/:id/portfolio', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!orgRole(uid, orgId)) return c.json({ error: 'not found' }, 404);
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(
    'SELECT id, name, base_date AS baseDate, tasks_json, archived, updated_at AS updatedAt FROM projects WHERE org_id = ? ORDER BY archived ASC, updated_at DESC'
  ).all(orgId);
  const projects = rows.map((p) => {
    let tasks = [];
    try { tasks = JSON.parse(p.tasks_json); } catch { /* empty */ }
    let wSum = 0, pv = 0, ev = 0, overdue = 0;
    for (const t of tasks) {
      const w = Number(t.weight) || 1;
      wSum += w;
      pv += w * ((Number(t.plannedProgress) || 0) / 100);
      ev += w * ((Number(t.actualProgress) || 0) / 100);
      if (t.plannedEndDate && t.plannedEndDate < today && (Number(t.actualProgress) || 0) < 100) overdue++;
    }
    const evm = computeEvm({ pv: wSum ? pv / wSum : 0, ev: wSum ? ev / wSum : 0 });
    return {
      id: p.id,
      name: p.name,
      archived: Boolean(p.archived),
      tasks: tasks.length,
      planned: Math.round(evm.pv * 1000) / 10,   // %
      actual: Math.round(evm.ev * 1000) / 10,    // %
      spi: evm.spi === null ? null : Math.round(evm.spi * 100) / 100,
      status: evm.status,
      label: evm.label,
      overdue,
      updatedAt: p.updatedAt,
    };
  });
  return c.json({ projects });
});

// AI 브리핑: 프로젝트 스냅샷(요약 지표 + 지연/차주 작업)을 contextual-
// orchestrator(LLM)로 보내 경영진용 리스크 분석을 생성. 원문 데이터는 서버가
// 요약해 전송하며, LLM 자격은 서버 환경변수에만 존재.
app.post('/api/projects/:id/ai/brief', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  let tasks = [];
  try { tasks = JSON.parse(p.tasks_json); } catch { /* empty */ }
  const today = new Date().toISOString().slice(0, 10);
  let wSum = 0, pv = 0, ev = 0;
  const late = [], upcoming = [];
  for (const t of tasks) {
    const w = Number(t.weight) || 1;
    wSum += w;
    pv += w * ((Number(t.plannedProgress) || 0) / 100);
    ev += w * ((Number(t.actualProgress) || 0) / 100);
    const name = t.name || t.task || t.activity || t.phase || t.id;
    if (t.plannedEndDate && t.plannedEndDate < today && (Number(t.actualProgress) || 0) < 100) {
      late.push(`${name}(계획종료 ${t.plannedEndDate}, 실적 ${Number(t.actualProgress) || 0}%${t.owner ? `, ${t.owner}` : ''})`);
    } else if (t.plannedStartDate && t.plannedStartDate >= today) {
      upcoming.push(`${name}(${t.plannedStartDate} 시작)`);
    }
  }
  const pvPct = wSum ? ((pv / wSum) * 100).toFixed(1) : '0';
  const evPct = wSum ? ((ev / wSum) * 100).toFixed(1) : '0';
  const context = [
    `프로젝트: ${p.name}`,
    `작업 수: ${tasks.length} · 계획진척 ${pvPct}% · 실적진척 ${evPct}%`,
    `지연 작업(${late.length}): ${late.slice(0, 8).join(' / ') || '없음'}`,
    `예정 작업(${upcoming.length}): ${upcoming.slice(0, 5).join(' / ') || '없음'}`,
  ].join('\n');
  try {
    const analysis = await orchestratorChat([
      { role: 'system', content: '너는 공정관리(schedule control) 전문가다. 주어진 프로젝트 지표를 근거로 한국어 경영진 브리핑을 작성하라: ①일정 상태 한 줄 판정 ②핵심 리스크 2~3개(근거 지표 인용) ③실행 권고 2~3개. 지표에 없는 사실은 만들지 마라.' },
      { role: 'user', content: context },
    ]);
    logAudit(p.org_id, uid, 'ai.brief', 'project', p.id, { tasks: tasks.length });
    return c.json({ analysis });
  } catch (e) {
    return c.json({ error: `AI 분석 실패: ${e.message}` }, 502);
  }
});

// 산출물 첨부(Clearfolio 통합 문서 뷰어 프록시): 업로드→변환 잡, 목록(+상태
// 갱신), 서명 아티팩트 열람(302), 삭제. 테넌트 = 조직, 브라우저에는 Clearfolio
// 자격이 절대 노출되지 않음.
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

const ATTACH_STATUS_CONCURRENCY = normalizeAttachmentStatusConcurrency(
  process.env.SCOPEWEAVE_ATTACHMENT_STATUS_CONCURRENCY,
);
const ATTACH_STATUS_TIMEOUT_MS = normalizeAttachmentStatusTimeoutMs(
  process.env.SCOPEWEAVE_ATTACHMENT_STATUS_TIMEOUT_MS,
);
const ATTACH_STATUS_BUDGET_MS = normalizeAttachmentStatusBudgetMs(
  process.env.SCOPEWEAVE_ATTACHMENT_STATUS_BUDGET_MS,
);
const ATTACHMENT_LIST_COLUMNS = `a.id, a.task_id AS taskId, a.name, a.mime, a.size,
  a.job_id AS jobId, a.status, a.created_at AS createdAt, u.email AS uploadedBy`;
const ATTACHMENT_LIST_FROM =
  'FROM attachments a LEFT JOIN users u ON u.id = a.created_by';
const listAttachmentsStatement = db.prepare(
  `SELECT ${ATTACHMENT_LIST_COLUMNS} ${ATTACHMENT_LIST_FROM}
   WHERE a.project_id = ? ORDER BY a.id DESC`,
);
const listTaskAttachmentsStatement = db.prepare(
  `SELECT ${ATTACHMENT_LIST_COLUMNS} ${ATTACHMENT_LIST_FROM}
   WHERE a.project_id = ? AND a.task_id = ? ORDER BY a.id DESC`,
);
const updateAttachmentStatusStatement = db.prepare(
  'UPDATE attachments SET status = ? WHERE id = ?',
);
app.post('/api/projects/:id/attachments', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'multipart file required' }, 400);
  const taskId = String(form.get('taskId') || '');
  if (/\.(hwp|hwpx)$/i.test(file.name || '')) return c.json({ error: 'HWP/HWPX는 지원되지 않습니다 (Clearfolio 정책)' }, 400);
  if (file.size > ATTACH_MAX_BYTES) return c.json({ error: 'file too large (max 10MB)' }, 400);
  const bytes = Buffer.from(await file.arrayBuffer());
  let job;
  try {
    job = await submitJob(p.org_id, uid, { name: file.name || 'document', mime: file.type || '', bytes });
  } catch (e) {
    return c.json({ error: `문서 변환 제출 실패: ${e.message}` }, 502);
  }
  const aid = rowid(db.prepare(
    'INSERT INTO attachments(project_id,task_id,name,mime,size,job_id,status,created_by) VALUES(?,?,?,?,?,?,?,?)'
  ).run(p.id, taskId, file.name || 'document', file.type || '', file.size, job.jobId, job.status, uid));
  logAudit(p.org_id, uid, 'attachment.upload', 'project', p.id, { attachmentId: aid, name: file.name, taskId: taskId || null });
  return c.json({ id: aid, status: job.status });
});

app.get('/api/projects/:id/attachments', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);

  const taskId = c.req.query('taskId');
  const rows = taskId
    ? listTaskAttachmentsStatement.all(p.id, taskId)
    : listAttachmentsStatement.all(p.id);
  await refreshAttachmentStatuses(rows, {
    orgId: p.org_id,
    userId: uid,
    jobStatus,
    updateStatus: (status, attachmentId) =>
      updateAttachmentStatusStatement.run(status, attachmentId),
    concurrency: ATTACH_STATUS_CONCURRENCY,
    timeoutMs: ATTACH_STATUS_TIMEOUT_MS,
    budgetMs: ATTACH_STATUS_BUDGET_MS,
    metrics,
  });
  const attachments = rows.map(({ jobId: _internalJobId, ...publicRow }) => publicRow);
  return c.json({ attachments });
});

// 열람: 서명 아티팩트 URL로 302. 새 탭 열기용으로 ?token=도 허용(ics/stream 패턴).
app.get('/api/projects/:id/attachments/:aid/view', (c) => {
  const header = c.req.header('authorization') || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : (c.req.query('token') || '');
  let uid;
  if (raw.startsWith('swk_')) {
    const row = db.prepare('SELECT user_id FROM api_tokens WHERE token_hash = ?').get(hashApiToken(raw));
    if (!row) return c.json({ error: 'unauthorized' }, 401);
    uid = row.user_id;
  } else {
    try {
      const payload = verifyToken(raw);
      const u = db.prepare('SELECT token_version FROM users WHERE id = ?').get(payload.sub);
      if (!u || (payload.tv || 0) !== u.token_version) return c.json({ error: 'unauthorized' }, 401);
      uid = payload.sub;
    } catch { return c.json({ error: 'unauthorized' }, 401); }
  }
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  const a = db.prepare('SELECT job_id, status FROM attachments WHERE id = ? AND project_id = ?').get(c.req.param('aid'), p.id);
  if (!a) return c.json({ error: 'not found' }, 404);
  if (a.status !== 'SUCCEEDED') return c.json({ error: `문서가 아직 준비되지 않았습니다 (${a.status})` }, 409);
  return artifactUrl(p.org_id, uid, a.job_id)
    .then((url) => c.redirect(url))
    .catch((e) => c.json({ error: `열람 링크 발급 실패: ${e.message}` }, 502));
});

app.delete('/api/projects/:id/attachments/:aid', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  const a = db.prepare('SELECT created_by FROM attachments WHERE id = ? AND project_id = ?').get(c.req.param('aid'), p.id);
  if (!a) return c.json({ error: 'not found' }, 404);
  if (a.created_by !== uid && !canManage(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  db.prepare('DELETE FROM attachments WHERE id = ?').run(c.req.param('aid'));
  logAudit(p.org_id, uid, 'attachment.delete', 'project', p.id, { attachmentId: Number(c.req.param('aid')) });
  return c.json({ ok: true });
});

// mock Clearfolio 아티팩트 서빙(dev/test 전용)
if (clearfolioMock) {
  app.get('/api/mock-clearfolio/:jobId', (c) => {
    const doc = mockArtifact(c.req.param('jobId'));
    if (!doc) return c.json({ error: 'not found' }, 404);
    return c.body(doc.bytes, 200, {
      'content-type': doc.mime || 'application/octet-stream',
      'content-disposition': `inline; filename="${encodeURIComponent(doc.name)}"`,
    });
  });
}

// Public read-only share links: a random token grants VIEW access to one
// project (no account needed) — revocable. Never exposes org/member data.
app.post('/api/projects/:id/shares', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canManage(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const token = randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO share_tokens(project_id, token, created_by) VALUES(?,?,?)').run(p.id, token, uid);
  logAudit(p.org_id, uid, 'share.create', 'project', p.id, {});
  return c.json({ token, url: `/?share=${token}` });
});

app.get('/api/projects/:id/shares', requireAuth, (c) => {
  const p = projectAccess(c.get('user').sub, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canManage(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const shares = db.prepare(
    'SELECT id, token, created_at AS createdAt FROM share_tokens WHERE project_id = ? AND revoked = 0 ORDER BY id DESC'
  ).all(p.id);
  return c.json({ shares });
});

app.delete('/api/projects/:id/shares/:sid', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canManage(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const info = db.prepare('UPDATE share_tokens SET revoked = 1 WHERE id = ? AND project_id = ? AND revoked = 0')
    .run(c.req.param('sid'), p.id);
  if (!info.changes) return c.json({ error: 'not found' }, 404);
  logAudit(p.org_id, uid, 'share.revoke', 'project', p.id, { shareId: Number(c.req.param('sid')) });
  return c.json({ ok: true });
});

// Anonymous read via share token — project content only.
app.get('/api/shared/:token', (c) => {
  const row = db.prepare(
    `SELECT p.name, p.base_date AS baseDate, p.tasks_json FROM share_tokens s
     JOIN projects p ON p.id = s.project_id WHERE s.token = ? AND s.revoked = 0`
  ).get(c.req.param('token'));
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ name: row.name, baseDate: row.baseDate, tasks: JSON.parse(row.tasks_json), readOnly: true });
});

// Unseen-activity notifications: per project, count others' saves + comments
// newer than my last-seen mark. Opening a project marks it seen.
app.get('/api/notifications', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const rows = db.prepare(
    `SELECT p.id AS projectId,
       (SELECT COUNT(*) FROM project_revisions r WHERE r.project_id = p.id
          AND r.saved_by IS NOT NULL AND r.saved_by != ?
          AND r.created_at > COALESCE(s.seen_at, '')) AS revisions,
       (SELECT COUNT(*) FROM comments cm WHERE cm.project_id = p.id
          AND cm.user_id IS NOT NULL AND cm.user_id != ?
          AND cm.created_at > COALESCE(s.seen_at, '')) AS comments
     FROM projects p
     JOIN memberships m ON m.org_id = p.org_id AND m.user_id = ?
     LEFT JOIN project_seen s ON s.project_id = p.id AND s.user_id = ?`
  ).all(uid, uid, uid, uid);
  const notifications = rows
    .map((r) => ({ projectId: r.projectId, unseen: r.revisions + r.comments }))
    .filter((r) => r.unseen > 0);
  return c.json({ notifications });
});

app.post('/api/projects/:id/seen', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  db.prepare(`INSERT INTO project_seen(project_id, user_id, seen_at) VALUES(?, ?, datetime('now'))
    ON CONFLICT(project_id, user_id) DO UPDATE SET seen_at = datetime('now')`).run(p.id, uid);
  return c.json({ ok: true });
});

// Archive / restore a project (write roles): declutter without deleting.
app.post('/api/projects/:id/archive', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const { archived } = await c.req.json().catch(() => ({}));
  const flag = archived === false ? 0 : 1;
  db.prepare('UPDATE projects SET archived = ? WHERE id = ?').run(flag, p.id);
  logAudit(p.org_id, uid, flag ? 'project.archive' : 'project.unarchive', 'project', p.id, {});
  return c.json({ id: p.id, archived: Boolean(flag) });
});

// Duplicate a project (template use: copy tasks + base date into a new project
// in the same org). Plan caps apply like any create.
app.post('/api/projects/:id/duplicate', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  if (wouldExceed(db, getOrg(p.org_id), 'projects')) {
    return c.json({ error: 'project limit reached on the Free plan', upgrade: true, limit: PLANS.free.limits.projects }, 402);
  }
  const { name } = await c.req.json().catch(() => ({}));
  const newName = String(name || `${p.name} (복사본)`).slice(0, 120);
  const nid = rowid(db.prepare('INSERT INTO projects(org_id,name,base_date,tasks_json,created_by) VALUES(?,?,?,?,?)')
    .run(p.org_id, newName, p.base_date, p.tasks_json, uid));
  metrics.projectsCreated++;
  logAudit(p.org_id, uid, 'project.duplicate', 'project', nid, { from: p.id, name: newName });
  return c.json({ id: nid, name: newName, version: 1 });
});

// -------------------------------------------------------------- sprints
// Agile/Hybrid: 시간상자(스프린트) CRUD. 작업은 task.sprint(이름)로 배정되고
// task.storyPoints로 추정된다 — 지표(커밋/완료 포인트, 벨로시티)는 클라이언트
// 순수 함수(computeSprintStats)가 계산한다.
app.post('/api/projects/:id/sprints', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const { name, startDate, endDate, goal } = await c.req.json().catch(() => ({}));
  if (!name || !String(name).trim()) return c.json({ error: 'name required' }, 400);
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : '');
  const sid = rowid(db.prepare('INSERT INTO sprints(project_id,name,start_date,end_date,goal) VALUES(?,?,?,?,?)')
    .run(p.id, String(name).trim().slice(0, 80), day(startDate), day(endDate), String(goal || '').slice(0, 300)));
  logAudit(p.org_id, uid, 'sprint.create', 'project', p.id, { sprintId: sid, name });
  return c.json({ id: sid, name: String(name).trim() });
});

app.get('/api/projects/:id/sprints', requireAuth, (c) => {
  const p = projectAccess(c.get('user').sub, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  const sprints = db.prepare(
    'SELECT id, name, start_date AS startDate, end_date AS endDate, goal FROM sprints WHERE project_id = ? ORDER BY start_date, id'
  ).all(p.id);
  return c.json({ sprints, methodology: p.methodology || 'waterfall' });
});

app.delete('/api/projects/:id/sprints/:sid', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const info = db.prepare('DELETE FROM sprints WHERE id = ? AND project_id = ?').run(c.req.param('sid'), p.id);
  if (!info.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// ------------------------------------------------------------- baselines
// Snapshot a project's current plan as a named baseline (schedule-control:
// compare actuals against the frozen plan later).
app.post('/api/projects/:id/baselines', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const id = c.req.param('id');
  const p = projectAccess(uid, id);
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const { name } = await c.req.json().catch(() => ({}));
  const bid = rowid(db.prepare('INSERT INTO baselines(project_id,name,base_date,tasks_json,created_by) VALUES(?,?,?,?,?)')
    .run(id, String(name || 'Baseline').slice(0, 80), p.base_date, p.tasks_json, uid));
  logAudit(p.org_id, uid, 'baseline.create', 'project', id, { baselineId: bid, name });
  return c.json({ id: bid, name: name || 'Baseline' });
});

app.get('/api/projects/:id/baselines', requireAuth, (c) => {
  const p = projectAccess(c.get('user').sub, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  const baselines = db.prepare(
    'SELECT id, name, base_date AS baseDate, created_at AS createdAt FROM baselines WHERE project_id = ? ORDER BY id DESC'
  ).all(p.id);
  return c.json({ baselines });
});

app.get('/api/projects/:id/baselines/:bid', requireAuth, (c) => {
  const p = projectAccess(c.get('user').sub, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  const b = db.prepare('SELECT id, name, base_date AS baseDate, tasks_json, created_at AS createdAt FROM baselines WHERE id = ? AND project_id = ?').get(c.req.param('bid'), p.id);
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ id: b.id, name: b.name, baseDate: b.baseDate, tasks: JSON.parse(b.tasks_json), createdAt: b.createdAt });
});

app.delete('/api/projects/:id/baselines/:bid', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const p = projectAccess(uid, c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  const info = db.prepare('DELETE FROM baselines WHERE id = ? AND project_id = ?').run(c.req.param('bid'), p.id);
  if (!info.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// ------------------------------------------------------ account & lifecycle
// Delete a project (write roles). tasks live in the row, so this fully removes it.
app.delete('/api/projects/:id', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const id = c.req.param('id');
  const p = projectAccess(uid, id);
  if (!p) return c.json({ error: 'not found' }, 404);
  if (!canWrite(p.memberRole)) return c.json({ error: 'forbidden' }, 403);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  logAudit(p.org_id, uid, 'project.delete', 'project', id, { name: p.name });
  deliver(p.org_id, 'project.delete', { projectId: Number(id) });
  return c.json({ ok: true });
});

// Log out everywhere: bump token_version → every existing JWT dies. Returns a
// fresh token so THIS device stays signed in. PATs are unaffected.
app.post('/api/auth/logout-all', requireAuth, (c) => {
  const uid = c.get('user').sub;
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(uid);
  const u = db.prepare('SELECT email, token_version FROM users WHERE id = ?').get(uid);
  return c.json({ ok: true, token: signToken({ sub: uid, email: u.email, tv: u.token_version }) });
});

// Change password (verifies the current one).
app.post('/api/auth/change-password', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const { oldPassword, newPassword } = await c.req.json().catch(() => ({}));
  if (typeof newPassword !== 'string' || newPassword.length < 8) return c.json({ error: 'new password (min 8) required' }, 400);
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(uid);
  if (!u || typeof oldPassword !== 'string' || !verifyPassword(oldPassword, u.password_hash)) {
    return c.json({ error: 'current password incorrect' }, 403);
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), uid);
  return c.json({ ok: true });
});

// Delete account (GDPR). Removes owned workspaces (cascading their data) and the
// user. Requires the current password to confirm.
app.delete('/api/account', requireAuth, async (c) => {
  const uid = c.get('user').sub;
  const { password } = await c.req.json().catch(() => ({}));
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(uid);
  if (!u || typeof password !== 'string' || !verifyPassword(password, u.password_hash)) {
    return c.json({ error: 'password required to delete account' }, 403);
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM orgs WHERE owner_id = ?').run(uid); // cascades projects/members/webhooks/invites/audit
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);       // cascades memberships/tokens
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return c.json({ ok: true });
});

app.get('/api/health', (c) => c.json({ ok: true }));

// Static client — strict allowlist so server/, data.db, package.json etc. are
// never served. Anything not listed → 404.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/404.html': ['404.html', 'text/html; charset=utf-8'],
  '/landing.html': ['landing.html', 'text/html; charset=utf-8'],
  '/landing.en.html': ['landing.en.html', 'text/html; charset=utf-8'],
  '/docs/api.md': ['docs/api.md', 'text/markdown; charset=utf-8'],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
  '/sitemap.xml': ['sitemap.xml', 'application/xml; charset=utf-8'],
  '/pricing': ['landing.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/cloud-sync.js': ['cloud-sync.js', 'text/javascript; charset=utf-8'],
  '/analytics.js': ['analytics.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/toast-state.css': ['toast-state.css', 'text/css; charset=utf-8'],
  '/wbs.json': ['wbs.json', 'application/json; charset=utf-8'],
};
app.get('*', async (c) => {
  const entry = STATIC[c.req.path];
  if (!entry) return c.notFound();
  try {
    const buf = await readFile(new URL(`../${entry[0]}`, import.meta.url));
    return c.body(buf, 200, { 'Content-Type': entry[1] });
  } catch {
    return c.notFound();
  }
});
