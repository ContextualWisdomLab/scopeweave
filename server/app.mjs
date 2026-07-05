// ScopeWeave SaaS API. Multi-tenant (org-scoped), optimistic concurrency on
// project docs, SSE realtime fan-out per project. The existing static client
// (index.html/app.js) becomes the frontend that talks to these routes.
import { Hono } from 'hono';
import { db, rowid } from './db.mjs';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.mjs';

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
    `SELECT p.* FROM projects p
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

app.get('/api/projects/:id/stream', requireAuth, (c) => {
  const id = c.req.param('id');
  if (!projectAccess(c.get('user').sub, id)) return c.json({ error: 'not found' }, 404);
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

app.get('/api/health', (c) => c.json({ ok: true }));
