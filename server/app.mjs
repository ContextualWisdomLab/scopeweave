// ScopeWeave SaaS API. Multi-tenant (org-scoped), optimistic concurrency on
// project docs, SSE realtime fan-out per project. The existing static client
// (index.html/app.js) becomes the frontend that talks to these routes.
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { db, rowid } from './db.mjs';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.mjs';

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
  const id = rowid(db.prepare('INSERT INTO projects(org_id,name,created_by) VALUES(?,?,?)').run(org.id, name, uid));
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
  return c.json({ token, email, role: inviteRole });
});

// Accept an invite (any authenticated user holding the token). Idempotent.
app.post('/api/invites/:token/accept', requireAuth, (c) => {
  const uid = c.get('user').sub;
  const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(c.req.param('token'));
  if (!inv || inv.accepted_at) return c.json({ error: 'invalid or used invite' }, 404);
  const existing = orgRole(uid, inv.org_id);
  if (!existing) {
    db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(inv.org_id, uid, inv.role);
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
  return c.json({ ok: true });
});

app.get('/api/health', (c) => c.json({ ok: true }));

// Static client — strict allowlist so server/, data.db, package.json etc. are
// never served. Anything not listed → 404.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/404.html': ['404.html', 'text/html; charset=utf-8'],
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
