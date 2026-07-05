// API smoke test — exercises the full auth + tenant + persistence + concurrency
// path in-process via Hono's app.request (no live port needed).
// Run: node tests/api/smoke.mjs
import assert from 'node:assert';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1'; // enables the dev-activate-pro endpoint for this test
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

// ---- Teams / RBAC ----
const orgAId = me.orgs[0].id;
// a viewer user (its own token; not yet a member of orgA)
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'viewer@x.com', password: 'password123' }) });
const vauth = { authorization: `Bearer ${(await r.json()).token}` };
// non-member cannot invite (404 hides the org's existence)
r = await req(`/api/orgs/${orgAId}/invites`, { method: 'POST', headers: vauth, body: body({ email: 'z@z.com' }) });
assert.equal(r.status, 404, 'non-member invite → 404');
// owner invites viewer@x.com as viewer
r = await req(`/api/orgs/${orgAId}/invites`, { method: 'POST', headers: auth, body: body({ email: 'viewer@x.com', role: 'viewer' }) });
assert.equal(r.status, 200, 'owner invite ok');
const invite = await r.json();
assert.ok(invite.token);
// viewer accepts → joins orgA as viewer
r = await req(`/api/invites/${invite.token}/accept`, { method: 'POST', headers: vauth });
assert.equal(r.status, 200);
assert.equal((await r.json()).role, 'viewer');
// reused invite → 404
r = await req(`/api/invites/${invite.token}/accept`, { method: 'POST', headers: vauth });
assert.equal(r.status, 404, 'used invite → 404');
// roster shows the viewer
r = await req(`/api/orgs/${orgAId}/members`, { headers: auth });
const roster = await r.json();
const vmember = roster.members.find((m) => m.email === 'viewer@x.com');
assert.ok(vmember && vmember.role === 'viewer', 'viewer in roster');
// viewer can READ but not WRITE the project
r = await req(`/api/projects/${proj.id}`, { headers: vauth });
assert.equal(r.status, 200, 'viewer read ok');
r = await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: vauth, body: body({ tasks: [], version: 2 }) });
assert.equal(r.status, 403, 'viewer write → 403');
// owner promotes viewer → member, who can now write
r = await req(`/api/orgs/${orgAId}/members/${vmember.id}`, { method: 'PATCH', headers: auth, body: body({ role: 'member' }) });
assert.equal(r.status, 200, 'promote ok');
r = await req(`/api/projects/${proj.id}`, { headers: vauth });
const curV = (await r.json()).version;
r = await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: vauth, body: body({ tasks: [{ id: 'm', name: '멤버작업' }], version: curV }) });
assert.equal(r.status, 200, 'promoted member can write');
// owner role is protected
r = await req(`/api/orgs/${orgAId}/members/${me.user.id}`, { method: 'PATCH', headers: auth, body: body({ role: 'member' }) });
assert.equal(r.status, 403, 'cannot demote owner');
// owner/admin can remove a member; owner cannot be removed
r = await req(`/api/orgs/${orgAId}/members/${me.user.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 403, 'cannot remove owner');
r = await req(`/api/orgs/${orgAId}/members/${vmember.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 200, 'remove member ok');

// SSE stream: query-token auth (EventSource can't send headers)
r = await req(`/api/projects/${proj.id}/stream?token=${encodeURIComponent(token)}`);
assert.equal(r.status, 200, 'SSE with valid query token → 200');
assert.match(r.headers.get('content-type') || '', /text\/event-stream/, 'SSE content-type');
await r.body?.cancel();
r = await req(`/api/projects/${proj.id}/stream`);
assert.equal(r.status, 401, 'SSE without token → 401');
await r.body?.cancel?.();

// Static allowlist — client files served, source/db never exposed
for (const [path, code] of [['/', 200], ['/index.html', 200], ['/app.js', 200], ['/cloud-sync.js', 200], ['/analytics.js', 200], ['/styles.css', 200], ['/wbs.json', 200]]) {
  const res = await req(path);
  assert.equal(res.status, code, `static ${path} → ${code}`);
}
for (const path of ['/server/app.mjs', '/server/db.mjs', '/data.db', '/package.json', '/../etc/passwd']) {
  const res = await req(path);
  assert.equal(res.status, 404, `blocked ${path} → 404`);
}

// ---- Billing / plan gating ----
// orgA on Free: 1 project, 1 member so far.
r = await req(`/api/orgs/${orgAId}/billing`, { headers: auth });
const bill = await r.json();
assert.equal(bill.plan, 'free');
assert.equal(bill.limits.projects, 2);
assert.equal(bill.usage.projects, 1);
// 2nd project under cap → ok; 3rd → 402
r = await req('/api/projects', { method: 'POST', headers: auth, body: body({ name: 'P2' }) });
assert.equal(r.status, 200, '2nd project ok');
r = await req('/api/projects', { method: 'POST', headers: auth, body: body({ name: 'P3' }) });
assert.equal(r.status, 402, '3rd project → 402 (Free cap)');
assert.equal((await r.json()).upgrade, true);
// member cap: fill to 3, 4th accept → 402
async function addMember(email) {
  const s = await req('/api/auth/signup', { method: 'POST', body: body({ email, password: 'password123' }) });
  const tok = (await s.json()).token;
  const inv = await (await req(`/api/orgs/${orgAId}/invites`, { method: 'POST', headers: auth, body: body({ email, role: 'member' }) })).json();
  return req(`/api/invites/${inv.token}/accept`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
}
assert.equal((await addMember('m2@x.com')).status, 200, 'member 2 ok');
assert.equal((await addMember('m3@x.com')).status, 200, 'member 3 ok (cap)');
assert.equal((await addMember('m4@x.com')).status, 402, '4th member → 402');
// checkout → mock url (no Stripe key), owner-only
r = await req(`/api/orgs/${orgAId}/checkout`, { method: 'POST', headers: auth });
assert.equal(r.status, 200);
const co = await r.json();
assert.ok(co.url && co.mock === true, 'mock checkout url');
// dev-activate → pro, caps lifted
r = await req(`/api/orgs/${orgAId}/_dev/activate-pro`, { method: 'POST', headers: auth });
assert.equal(r.status, 200);
assert.equal((await r.json()).plan, 'pro');
r = await req('/api/projects', { method: 'POST', headers: auth, body: body({ name: 'P3-pro' }) });
assert.equal(r.status, 200, 'project cap lifted on Pro');
assert.equal((await addMember('m4b@x.com')).status, 200, 'member cap lifted on Pro');

// ---- Personal Access Tokens (PAT) ----
r = await req('/api/tokens', { method: 'POST', headers: auth, body: body({ name: 'CI token' }) });
assert.equal(r.status, 200);
const pat = await r.json();
assert.ok(pat.token.startsWith('swk_'), 'PAT secret has swk_ prefix');
const patAuth = { authorization: `Bearer ${pat.token}` };
// PAT authenticates the public API as its user
r = await req('/api/projects', { headers: patAuth });
assert.equal(r.status, 200, 'PAT authenticates');
assert.ok(Array.isArray((await r.json()).projects));
// listing shows prefix + lastUsed, never the secret/hash
r = await req('/api/tokens', { headers: auth });
const listed = (await r.json()).tokens.find((t) => t.id === pat.id);
assert.ok(listed && listed.prefix === pat.prefix, 'token listed by prefix');
assert.ok(!('token' in listed) && !('token_hash' in listed) && !('hash' in listed), 'secret never returned in list');
assert.ok(listed.lastUsed, 'lastUsed updated after PAT use');
// revoke → PAT rejected
r = await req(`/api/tokens/${pat.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 200);
r = await req('/api/projects', { headers: patAuth });
assert.equal(r.status, 401, 'revoked PAT → 401');
r = await req(`/api/tokens/${pat.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 404, 'double-revoke → 404');

console.log('✓ API smoke tests passed');
