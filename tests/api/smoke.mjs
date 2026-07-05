// API smoke test — exercises the full auth + tenant + persistence + concurrency
// path in-process via Hono's app.request (no live port needed).
// Run: node tests/api/smoke.mjs
import assert from 'node:assert';

process.env.SCOPEWEAVE_DB = ':memory:';
const { app } = await import('../../server/app.mjs');

const req = (path, opts = {}) =>
  app.request(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
const body = (o) => JSON.stringify(o);

// signup → token + auto workspace
let r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'a@b.com', password: 'password123', name: 'A' }) });
assert.equal(r.status, 200, 'signup ok');
const { token } = await r.json();
assert.ok(token, 'got token');
const auth = { authorization: `Bearer ${token}` };

// duplicate email rejected
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'a@b.com', password: 'password123' }) });
assert.equal(r.status, 409, 'duplicate email → 409');

// weak password rejected
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'x@y.com', password: 'short' }) });
assert.equal(r.status, 400, 'weak password → 400');

// wrong password rejected
r = await req('/api/auth/login', { method: 'POST', body: body({ email: 'a@b.com', password: 'nope' }) });
assert.equal(r.status, 401, 'bad login → 401');

// me — has an owner workspace
r = await req('/api/me', { headers: auth });
assert.equal(r.status, 200);
const me = await r.json();
assert.equal(me.user.email, 'a@b.com');
assert.equal(me.orgs.length, 1);
assert.equal(me.orgs[0].role, 'owner');

// unauthenticated me rejected
r = await req('/api/me');
assert.equal(r.status, 401, 'no token → 401');

// forged token (tampered) rejected — alg-confusion / signature check
const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
r = await req('/api/me', { headers: { authorization: `Bearer ${forged}` } });
assert.equal(r.status, 401, 'forged token → 401');

// create project
r = await req('/api/projects', { method: 'POST', headers: auth, body: body({ name: 'P1' }) });
assert.equal(r.status, 200);
const proj = await r.json();
assert.ok(proj.id);
assert.equal(proj.version, 1);

// save tasks with matching version → bump
const tasks = [{ id: '1', name: '준비단계', owner: '담당자A' }];
r = await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ tasks, baseDate: '2026-01-01', version: 1 }) });
assert.equal(r.status, 200);
assert.equal((await r.json()).version, 2, 'version bumped to 2');

// stale version → 409 conflict
r = await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ tasks, version: 1 }) });
assert.equal(r.status, 409, 'stale write → 409');

// load back — persisted tasks + version
r = await req(`/api/projects/${proj.id}`, { headers: auth });
const loaded = await r.json();
assert.equal(loaded.tasks[0].name, '준비단계');
assert.equal(loaded.baseDate, '2026-01-01');
assert.equal(loaded.version, 2);

// tenant isolation — a second user cannot read the first user's project
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'c@d.com', password: 'password123' }) });
const t2 = (await r.json()).token;
r = await req(`/api/projects/${proj.id}`, { headers: { authorization: `Bearer ${t2}` } });
assert.equal(r.status, 404, 'cross-tenant read → 404');

// and cannot write it either
r = await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: { authorization: `Bearer ${t2}` }, body: body({ tasks: [], version: 2 }) });
assert.equal(r.status, 404, 'cross-tenant write → 404');

// SSE stream: query-token auth (EventSource can't send headers)
r = await req(`/api/projects/${proj.id}/stream?token=${encodeURIComponent(token)}`);
assert.equal(r.status, 200, 'SSE with valid query token → 200');
assert.match(r.headers.get('content-type') || '', /text\/event-stream/, 'SSE content-type');
await r.body?.cancel();
r = await req(`/api/projects/${proj.id}/stream`);
assert.equal(r.status, 401, 'SSE without token → 401');
await r.body?.cancel?.();

// Static allowlist — client files served, source/db never exposed
for (const [path, code] of [['/', 200], ['/index.html', 200], ['/app.js', 200], ['/cloud-sync.js', 200], ['/styles.css', 200], ['/wbs.json', 200]]) {
  const res = await req(path);
  assert.equal(res.status, code, `static ${path} → ${code}`);
}
for (const path of ['/server/app.mjs', '/server/db.mjs', '/data.db', '/package.json', '/../etc/passwd']) {
  const res = await req(path);
  assert.equal(res.status, 404, `blocked ${path} → 404`);
}

console.log('✓ API smoke tests passed');
