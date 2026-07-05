// ScopeWeave SaaS API. Multi-tenant (org-scoped), optimistic concurrency on
// project docs, SSE realtime fan-out per project. The existing static client
// (index.html/app.js) becomes the frontend that talks to these routes.
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHmac } from 'node:crypto';
import { db, rowid } from './db.mjs';
import { hashPassword, verifyPassword, signToken, verifyToken, generateApiToken, hashApiToken } from './auth.mjs';
import { PLANS, planOf, orgUsage, wouldExceed, createCheckout } from './billing.mjs';

const getOrg = (id) => db.prepare('SELECT * FROM orgs WHERE id = ?').get(id);

// Append-only audit trail. Never throws into the request path.
function logAudit(orgId, userId, action, targetType, targetId, meta) {
  try {
    db.prepare('INSERT INTO audit_log(org_id,user_id,action,target_type,target_id,meta) VALUES(?,?,?,?,?,?)')
      .run(orgId, userId ?? null, action, targetType ?? null, targetId != null ? String(targetId) : null, meta ? JSON.stringify(meta) : null);
  } catch { /* audit must not break the operation */ }
}

// --- RBAC. Roles (highest→lowest): owner > admin > member > viewer.
const ROLES = ['owner', 'admin', 'member', 'viewer'];
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
    c.set('user', verifyToken(token));
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
const metrics = { startedAt: new Date().toISOString(), requests: 0, s2xx: 0, s4xx: 0, s5xx: 0, signups: 0, projectsCreated: 0, webhookDeliveries: 0 };

// Outbound webhooks: POST signed JSON to each active hook subscribed to `event`.
// Fire-and-forget with a timeout — never blocks or fails the triggering request.
function deliver(orgId, event, payload) {
  let hooks;
  try {
    hooks = db.prepare('SELECT url, secret, events FROM webhooks WHERE org_id = ? AND active = 1').all(orgId);
  } catch { return; }
  for (const h of hooks) {
    const subs = String(h.events || '').split(',').map((s) => s.trim());
    if (!(subs.includes('*') || subs.includes(event))) continue;
    const body = JSON.stringify({ event, orgId: Number(orgId), payload, ts: new Date().toISOString() });
    const sig = createHmac('sha256', h.secret).update(body).digest('hex');
    metrics.webhookDeliveries++;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-scopeweave-event': event, 'x-scopeweave-signature': `sha256=${sig}` },
      body,
      signal: ctrl.signal,
    }).catch(() => {}).finally(() => clearTimeout(to));
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

app.post('/api/auth/signup', async (c) => {
  const { email, password, name } = await c.req.json().catch(() => ({}));
  if (!email || !password || String(password).length < 8) {
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
  return c.json({ token: signToken({ sub: uid, email }) });
});

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email || '');
  if (!u || !verifyPassword(password || '', u.password_hash)) {
    return c.json({ error: 'invalid credentials' }, 401);
  }
  return c.json({ token: signToken({ sub: u.id, email: u.email }) });
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

app.get('/api/projects', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const projects = db.prepare(
    `SELECT p.id,p.name,p.base_date AS baseDate,p.version,p.org_id AS orgId,p.updated_at AS updatedAt
     FROM projects p JOIN memberships m ON m.org_id = p.org_id
     WHERE m.user_id = ? ORDER BY p.updated_at DESC`
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
  return c.json({ id: p.id, name: p.name, baseDate: p.base_date, tasks: JSON.parse(p.tasks_json), version: p.version });
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
  db.prepare(
    "UPDATE projects SET name=?, base_date=?, tasks_json=?, version=?, updated_at=datetime('now') WHERE id=?"
  ).run(body.name ?? p.name, body.baseDate ?? p.base_date, JSON.stringify(tasks), version, id);
  logAudit(p.org_id, uid, 'project.update', 'project', id, { version, tasks: tasks.length });
  deliver(p.org_id, 'project.update', { projectId: Number(id), version, tasks: tasks.length, by: uid });
  broadcast(id, { type: 'update', version, by: uid });
  return c.json({ version });
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
    `SELECT email, role, token, created_at AS createdAt FROM invites
     WHERE org_id = ? AND accepted_at IS NULL ORDER BY id DESC`
  ).all(orgId);
  return c.json({ members, invites });
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
  return c.json({
    ...metrics,
    sseActive,
    uptimeSec: Math.round(process.uptime()),
  });
});

// ------------------------------------------------------------------- webhooks
app.get('/api/orgs/:id/webhooks', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const webhooks = db.prepare(
    'SELECT id, url, events, active, created_at AS createdAt FROM webhooks WHERE org_id = ? ORDER BY id DESC'
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

app.delete('/api/orgs/:id/webhooks/:whId', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const orgId = c.req.param('id');
  if (!canManage(orgRole(uid, orgId))) return c.json({ error: 'forbidden' }, 403);
  const info = db.prepare('DELETE FROM webhooks WHERE id = ? AND org_id = ?').run(c.req.param('whId'), orgId);
  if (!info.changes) return c.json({ error: 'not found' }, 404);
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
  '/pricing': ['landing.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/cloud-sync.js': ['cloud-sync.js', 'text/javascript; charset=utf-8'],
  '/analytics.js': ['analytics.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
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
