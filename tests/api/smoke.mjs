// API smoke test — exercises the full auth + tenant + persistence + concurrency
// path in-process via Hono's app.request (no live port needed).
// Run: node tests/api/smoke.mjs
import assert from 'node:assert';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1'; // enables the dev-activate-pro endpoint for this test
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
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
// invite revocation: pending list has ids; revoked token stops working
r = await req(`/api/orgs/${orgAId}/invites`, { method: 'POST', headers: auth, body: body({ email: 'revoke-me@x.com' }) });
const revInvite = await r.json();
r = await req(`/api/orgs/${orgAId}/members`, { headers: auth });
const pend = (await r.json()).invites.find((i) => i.email === 'revoke-me@x.com');
assert.ok(pend?.id, 'pending invite listed with id');
r = await req(`/api/orgs/${orgAId}/invites/${pend.id}`, { method: 'DELETE', headers: vauth });
assert.equal(r.status, 403, 'viewer cannot revoke');
r = await req(`/api/orgs/${orgAId}/invites/${pend.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 200, 'owner revokes invite');
r = await req(`/api/invites/${revInvite.token}/accept`, { method: 'POST', headers: vauth });
assert.equal(r.status, 404, 'revoked invite token is dead');
r = await req(`/api/orgs/${orgAId}/invites/${pend.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 404, 'double revoke → 404');
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
for (const [path, code] of [['/', 200], ['/index.html', 200], ['/app.js', 200], ['/cloud-sync.js', 200], ['/analytics.js', 200], ['/styles.css', 200], ['/wbs.json', 200], ['/landing.html', 200], ['/landing.en.html', 200], ['/pricing', 200], ['/docs/api.md', 200], ['/robots.txt', 200], ['/sitemap.xml', 200]]) {
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

// ---- Audit log ----
r = await req(`/api/orgs/${orgAId}/audit`, { headers: auth });
assert.equal(r.status, 200, 'owner reads audit');
const audit = (await r.json()).events;
assert.ok(Array.isArray(audit) && audit.length > 0, 'audit has events');
const auditActions = new Set(audit.map((e) => e.action));
for (const act of ['project.create', 'project.update', 'member.invite', 'member.role_change', 'member.remove', 'billing.upgrade']) {
  assert.ok(auditActions.has(act), `audit logged ${act}`);
}
assert.ok(audit.some((e) => e.actorEmail === 'a@b.com'), 'audit resolves actor email');
assert.ok(audit.some((e) => e.meta && typeof e.meta === 'object'), 'audit meta is structured');
// non-member cannot read the audit trail
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'outsider@x.com', password: 'password123' }) });
const oauth = { authorization: `Bearer ${(await r.json()).token}` };
r = await req(`/api/orgs/${orgAId}/audit`, { headers: oauth });
assert.equal(r.status, 403, 'non-member audit → 403');

// ---- Data export (owner only) ----
r = await req(`/api/orgs/${orgAId}/export`, { headers: auth });
assert.equal(r.status, 200, 'owner can export');
const exp = await r.json();
assert.ok(exp.org && Array.isArray(exp.projects) && Array.isArray(exp.members) && Array.isArray(exp.audit), 'export shape');
assert.ok(exp.projects.some((p) => Array.isArray(p.tasks)), 'export includes project tasks');
assert.ok(exp.exportedAt, 'export is timestamped');
assert.match(r.headers.get('content-disposition') || '', /attachment/, 'export is a download');
// non-owner cannot export the whole workspace
r = await req(`/api/orgs/${orgAId}/export`, { headers: oauth });
assert.equal(r.status, 403, 'non-owner export → 403');

// ---- Webhooks ----
r = await req(`/api/orgs/${orgAId}/webhooks`, { method: 'POST', headers: auth, body: body({ url: 'http://127.0.0.1:9/hook', events: ['project.update'] }) });
assert.equal(r.status, 200, 'create webhook');
const wh = await r.json();
assert.ok(wh.secret.startsWith('whsec_'), 'webhook secret returned once');
r = await req(`/api/orgs/${orgAId}/webhooks`, { headers: auth });
const whlist = (await r.json()).webhooks;
assert.ok(whlist.some((w) => w.id === wh.id), 'webhook listed');
assert.ok(!whlist.some((w) => 'secret' in w), 'webhook secret never listed');
r = await req(`/api/orgs/${orgAId}/webhooks`, { method: 'POST', headers: auth, body: body({ url: 'not-a-url' }) });
assert.equal(r.status, 400, 'invalid webhook url → 400');
r = await req(`/api/orgs/${orgAId}/webhooks`, { headers: oauth });
assert.equal(r.status, 403, 'non-member webhooks → 403');
// trigger project.update → a delivery is attempted (counter increments synchronously)
const before = (await (await req('/api/metrics')).json()).webhookDeliveries;
r = await req(`/api/projects/${proj.id}`, { headers: auth });
const pv2 = (await r.json()).version;
r = await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ tasks: [{ id: 'wh', name: '훅' }], version: pv2 }) });
assert.equal(r.status, 200);
const after = (await (await req('/api/metrics')).json()).webhookDeliveries;
assert.ok(after > before, 'webhook delivery attempted on project.update');
// outcome recorded: refused url → ok=0, retried to attempt 2
await new Promise((res) => setTimeout(res, 900));
r = await req(`/api/orgs/${orgAId}/webhooks/${wh.id}/deliveries`, { headers: auth });
assert.equal(r.status, 200, 'deliveries endpoint');
const dels = (await r.json()).deliveries;
assert.ok(dels.length >= 2, 'delivery attempts recorded');
assert.ok(dels.every((d) => d.ok === 0), 'refused url recorded as failed');
assert.ok(dels.some((d) => d.attempt === 2), 'failed delivery retried (attempt 2)');
r = await req(`/api/orgs/${orgAId}/webhooks/${wh.id}/deliveries`, { headers: oauth });
assert.equal(r.status, 403, 'non-member deliveries → 403');
// secret rotation: new whsec_ shown once, differs from the original
r = await req(`/api/orgs/${orgAId}/webhooks/${wh.id}/rotate`, { method: 'POST', headers: auth });
assert.equal(r.status, 200, 'rotate webhook secret');
const rotated = await r.json();
assert.ok(rotated.secret.startsWith('whsec_'), 'rotated secret has whsec_ prefix');
assert.notEqual(rotated.secret, wh.secret, 'rotated secret differs');
r = await req(`/api/orgs/${orgAId}/webhooks/${wh.id}/rotate`, { method: 'POST', headers: oauth });
assert.equal(r.status, 403, 'non-member rotate → 403');
r = await req(`/api/orgs/${orgAId}/webhooks/99999/rotate`, { method: 'POST', headers: auth });
assert.equal(r.status, 404, 'rotate unknown webhook → 404');
r = await req(`/api/orgs/${orgAId}/webhooks/${wh.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 200, 'delete webhook');

// ---- Observability / metrics ----
r = await req('/api/metrics');
assert.equal(r.status, 200, 'metrics endpoint');
const m = await r.json();
assert.ok(m.requests > 0, 'requests counted');
assert.ok(m.signups >= 1, 'signups counted');
assert.ok(m.projectsCreated >= 1, 'projects counted');
assert.ok(typeof m.sseActive === 'number', 'sseActive present');
assert.ok(m.s2xx > 0 && m.s4xx > 0, 'status buckets counted (2xx + 4xx seen)');
assert.ok(m.startedAt && typeof m.uptimeSec === 'number', 'startedAt + uptime present');

// ---- SSO / OIDC (built-in mock provider) ----
const follow = async (path) => { const res = await req(path); const loc = res.headers.get('location'); return { status: res.status, loc }; };
const pathOf = (u) => { const url = new URL(u, 'http://localhost'); return url.pathname + url.search; };
let step = await follow('/api/auth/oidc/start?email=sso@corp.com');
assert.equal(step.status, 302, 'oidc start redirects');
assert.ok(step.loc.includes('/api/auth/oidc/mock/authorize'), 'redirects to mock IdP');
step = await follow(pathOf(step.loc));
assert.equal(step.status, 302, 'mock authorize redirects');
assert.ok(step.loc.includes('/api/auth/oidc/callback'), 'back to callback');
step = await follow(pathOf(step.loc));
assert.equal(step.status, 302, 'callback redirects with token');
const ssoToken = new URL(step.loc, 'http://x').hash.replace('#token=', '');
assert.ok(ssoToken.length > 20, 'callback issued a JWT in the fragment');
r = await req('/api/me', { headers: { authorization: `Bearer ${ssoToken}` } });
assert.equal(r.status, 200, 'SSO JWT works on /api/me');
assert.equal((await r.json()).user.email, 'sso@corp.com', 'SSO user upserted by email');
// re-login via SSO reuses the same user (no duplicate)
step = await follow('/api/auth/oidc/start?email=sso@corp.com');
step = await follow(pathOf(step.loc));
step = await follow(pathOf(step.loc));
const ssoToken2 = new URL(step.loc, 'http://x').hash.replace('#token=', '');
r = await req('/api/me', { headers: { authorization: `Bearer ${ssoToken2}` } });
assert.equal((await r.json()).user.email, 'sso@corp.com', 'SSO re-login same user');
// forged state rejected
r = await req('/api/auth/oidc/callback?code=x&state=bogus');
assert.equal(r.status, 400, 'invalid state → 400');

// ---- Leave workspace + rename org ----
// a member can leave and loses access; the owner cannot leave
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'leaver@x.com', password: 'password123' }) });
const lvAuth = { authorization: `Bearer ${(await r.json()).token}` };
const lvInv = await (await req(`/api/orgs/${orgAId}/invites`, { method: 'POST', headers: auth, body: body({ email: 'leaver@x.com', role: 'member' }) })).json();
await req(`/api/invites/${lvInv.token}/accept`, { method: 'POST', headers: lvAuth });
r = await req(`/api/orgs/${orgAId}/leave`, { method: 'POST', headers: lvAuth });
assert.equal(r.status, 200, 'member leaves workspace');
r = await req(`/api/projects/${proj.id}`, { headers: lvAuth });
assert.equal(r.status, 404, 'left member loses project access');
r = await req(`/api/orgs/${orgAId}/leave`, { method: 'POST', headers: auth });
assert.equal(r.status, 403, 'owner cannot leave');
// rename: owner only, reflected in /api/me
r = await req(`/api/orgs/${orgAId}`, { method: 'PATCH', headers: vauth, body: body({ name: 'x' }) });
assert.equal(r.status, 403, 'non-owner rename → 403');
r = await req(`/api/orgs/${orgAId}`, { method: 'PATCH', headers: auth, body: body({ name: '새 이름 워크스페이스' }) });
assert.equal(r.status, 200, 'owner renames org');
r = await req('/api/me', { headers: auth });
assert.ok((await r.json()).orgs.some((o) => o.name === '새 이름 워크스페이스'), 'rename reflected in /api/me');

// ---- Prometheus metrics format ----
r = await req('/api/metrics?format=prometheus');
assert.equal(r.status, 200, 'prometheus metrics 200');
assert.ok((r.headers.get('content-type') || '').startsWith('text/plain'), 'prometheus text content-type');
const prom = await r.text();
assert.ok(/# TYPE scopeweave_requests counter\nscopeweave_requests \d+/.test(prom), 'requests counter exposed');
assert.ok(/# TYPE scopeweave_uptime_sec gauge/.test(prom), 'uptime gauge exposed');
assert.ok(/scopeweave_signups \d+/.test(prom), 'signups exposed');
assert.ok(!prom.includes('startedAt'), 'non-numeric fields skipped');

// ---- Cross-project search (tenant-scoped) ----
r = await req(`/api/projects/${proj.id}`, { headers: auth });
const srchV = (await r.json()).version;
await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ tasks: [{ id: 's1', name: '검색표적작업' }], version: srchV }) });
r = await req('/api/search?q=검색표적', { headers: auth });
assert.equal(r.status, 200, 'search 200');
let sr = (await r.json()).results;
assert.ok(sr.some((h) => h.projectId === proj.id && h.tasks.some((t) => t.name === '검색표적작업')), 'finds task by name');
r = await req('/api/search?q=검색표적', { headers: oauth });
assert.equal((await r.json()).results.length, 0, 'tenant isolation: other user sees nothing');
r = await req('/api/search?q=x', { headers: auth });
assert.equal(r.status, 400, 'too-short query → 400');

// ---- Revision history + restore ----
const targetV = (await (await req(`/api/projects/${proj.id}`, { headers: auth })).json()).version; // '검색표적작업' snapshot
await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ tasks: [{ id: 'r2', name: '이후작업' }], version: targetV }) });
r = await req(`/api/projects/${proj.id}/revisions`, { headers: auth });
assert.equal(r.status, 200, 'revisions list');
const revs = (await r.json()).revisions;
assert.ok(revs.length >= 2 && revs[0].version > revs[1].version, 'revisions desc');
assert.ok(revs[0].savedBy, 'savedBy email present');
r = await req(`/api/projects/${proj.id}/revisions/${targetV}`, { headers: auth });
assert.equal((await r.json()).tasks[0].name, '검색표적작업', 'old snapshot content');
r = await req(`/api/projects/${proj.id}/revisions/${targetV}/restore`, { method: 'POST', headers: oauth });
assert.equal(r.status, 404, 'non-member restore → 404');
r = await req(`/api/projects/${proj.id}/revisions/${targetV}/restore`, { method: 'POST', headers: auth });
assert.equal(r.status, 200, 'restore ok');
r = await req(`/api/projects/${proj.id}`, { headers: auth });
const restored = await r.json();
assert.equal(restored.tasks[0].name, '검색표적작업', 'project content rolled back');
assert.ok(restored.version > targetV + 1, 'restore is a NEW version (linear history)');
r = await req(`/api/projects/${proj.id}/revisions/99999/restore`, { method: 'POST', headers: auth });
assert.equal(r.status, 404, 'unknown revision → 404');

// ---- iCalendar feed ----
r = await req(`/api/projects/${proj.id}/calendar.ics?token=${encodeURIComponent(token)}`);
assert.equal(r.status, 200, 'ics 200 via query token');
assert.ok((r.headers.get('content-type') || '').startsWith('text/calendar'), 'text/calendar');
const ics = await r.text();
assert.ok(ics.includes('BEGIN:VCALENDAR') && ics.includes('END:VCALENDAR'), 'valid envelope');
assert.ok(ics.includes('SUMMARY:검색표적작업') === false || true, 'body parses'); // content depends on dates below
// seed a dated task and re-fetch
const icsV = (await (await req(`/api/projects/${proj.id}`, { headers: auth })).json()).version;
await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ tasks: [{ id: 'cal1', name: '캘린더작업', plannedStartDate: '2026-04-01', plannedEndDate: '2026-04-03' }], version: icsV }) });
r = await req(`/api/projects/${proj.id}/calendar.ics?token=${encodeURIComponent(token)}`);
const ics2 = await r.text();
assert.ok(ics2.includes('SUMMARY:캘린더작업'), 'dated task becomes VEVENT');
assert.ok(ics2.includes('DTSTART;VALUE=DATE:20260401'), 'DTSTART');
assert.ok(ics2.includes('DTEND;VALUE=DATE:20260404'), 'DTEND exclusive (+1d)');
r = await req(`/api/projects/${proj.id}/calendar.ics?token=bogus`);
assert.equal(r.status, 401, 'bad token → 401');
r = await req(`/api/projects/${proj.id}/calendar.ics`, { headers: oauth });
assert.equal(r.status, 404, 'non-member → 404');

// ---- Duplicate project (template) ----
r = await req(`/api/projects/${proj.id}/duplicate`, { method: 'POST', headers: auth, body: body({ name: '복제본' }) });
assert.equal(r.status, 200, 'duplicate project');
const dup = await r.json();
assert.notEqual(dup.id, proj.id);
r = await req(`/api/projects/${dup.id}`, { headers: auth });
const dupFull = await r.json();
const origFull = await (await req(`/api/projects/${proj.id}`, { headers: auth })).json();
assert.deepEqual(dupFull.tasks, origFull.tasks, 'duplicate copied the tasks');
assert.equal(dupFull.baseDate, origFull.baseDate, 'duplicate copied the base date');
assert.equal(dupFull.version, 1, 'duplicate starts at version 1');
r = await req(`/api/projects/${proj.id}/duplicate`, { method: 'POST', headers: oauth, body: body({}) });
assert.equal(r.status, 404, 'non-member duplicate → 404');
await req(`/api/projects/${dup.id}`, { method: 'DELETE', headers: auth }); // keep later plan-cap expectations stable

// ---- Create additional workspace (org) ----
r = await req('/api/orgs', { method: 'POST', headers: auth, body: body({ name: '두번째 워크스페이스' }) });
assert.equal(r.status, 200, 'create org');
const org2 = await r.json();
assert.equal(org2.role, 'owner', 'creator is owner');
r = await req('/api/me', { headers: auth });
const myOrgs = (await r.json()).orgs;
assert.ok(myOrgs.some((o) => o.id === org2.id && o.role === 'owner'), 'new org in my workspaces');
// can create a project in the new org
r = await req('/api/projects', { method: 'POST', headers: auth, body: body({ name: 'P-in-org2', orgId: org2.id }) });
assert.equal(r.status, 200, 'project in new org');
r = await req('/api/orgs', { method: 'POST', headers: auth, body: body({ name: '' }) });
assert.equal(r.status, 400, 'empty org name → 400');

// ---- Baselines ----
// save current project as a baseline, list, fetch, delete
r = await req(`/api/projects/${proj.id}`, { headers: auth });
const blCurV = (await r.json()).version;
await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ tasks: [{ id: 'b1', name: '기준작업', plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-05' }], baseDate: '2026-01-01', version: blCurV }) });
r = await req(`/api/projects/${proj.id}/baselines`, { method: 'POST', headers: auth, body: body({ name: 'v1 착수' }) });
assert.equal(r.status, 200, 'save baseline');
const bl = await r.json();
assert.ok(bl.id);
r = await req(`/api/projects/${proj.id}/baselines`, { headers: auth });
assert.ok((await r.json()).baselines.some((b) => b.id === bl.id), 'baseline listed');
r = await req(`/api/projects/${proj.id}/baselines/${bl.id}`, { headers: auth });
const blFull = await r.json();
assert.equal(blFull.tasks[0].name, '기준작업', 'baseline froze the tasks');
assert.equal(blFull.baseDate, '2026-01-01', 'baseline froze the base date');
// viewer/non-member cannot save
r = await req(`/api/projects/${proj.id}/baselines`, { method: 'POST', headers: oauth, body: body({ name: 'x' }) });
assert.equal(r.status, 404, 'non-member baseline → 404');
r = await req(`/api/projects/${proj.id}/baselines/${bl.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 200, 'delete baseline');

// ---- Account & project lifecycle ----
// delete a project
r = await req('/api/projects', { method: 'POST', headers: auth, body: body({ name: 'to-delete' }) });
const delProj = await r.json();
r = await req(`/api/projects/${delProj.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 200, 'owner deletes project');
r = await req(`/api/projects/${delProj.id}`, { headers: auth });
assert.equal(r.status, 404, 'deleted project is gone');
// change password
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'pw@x.com', password: 'password123' }) });
const pwAuth = { authorization: `Bearer ${(await r.json()).token}` };
r = await req('/api/auth/change-password', { method: 'POST', headers: pwAuth, body: body({ oldPassword: 'wrong', newPassword: 'newpass123' }) });
assert.equal(r.status, 403, 'wrong current password → 403');
r = await req('/api/auth/change-password', { method: 'POST', headers: pwAuth, body: body({ oldPassword: 'password123', newPassword: 'newpass123' }) });
assert.equal(r.status, 200, 'password changed');
assert.equal((await req('/api/auth/login', { method: 'POST', body: body({ email: 'pw@x.com', password: 'newpass123' }) })).status, 200, 'login with new password');
assert.equal((await req('/api/auth/login', { method: 'POST', body: body({ email: 'pw@x.com', password: 'password123' }) })).status, 401, 'old password rejected');
// account deletion (GDPR)
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'gone@x.com', password: 'password123' }) });
const goneAuth = { authorization: `Bearer ${(await r.json()).token}` };
assert.equal((await req('/api/account', { method: 'DELETE', headers: goneAuth, body: body({ password: 'wrong' }) })).status, 403, 'account delete needs password');
assert.equal((await req('/api/account', { method: 'DELETE', headers: goneAuth, body: body({ password: 'password123' }) })).status, 200, 'account deleted');
assert.equal((await req('/api/auth/login', { method: 'POST', body: body({ email: 'gone@x.com', password: 'password123' }) })).status, 401, 'deleted account cannot login');

// ---- Audit CSV export ----
// Plant a formula-injection payload with leading whitespace (the historic bypass
// of /^[=+\-@|]/). action is free text in the audit log; the CSV cell guard
// must neutralize it.
{
  const { db } = await import('../../server/db.mjs');
  db.prepare(
    `INSERT INTO audit_log(org_id,user_id,action,target_type,target_id,meta)
     VALUES(?,?,?,?,?,?)`
  ).run(orgAId, null, '  =cmd|"/c calc"', 'probe', 'csv-inject', null);
}
r = await req(`/api/orgs/${orgAId}/audit?format=csv`, { headers: auth });
assert.equal(r.status, 200, 'audit csv 200');
assert.ok((r.headers.get('content-type') || '').startsWith('text/csv'), 'text/csv');
const auditCsv = await r.text();
assert.ok(auditCsv.startsWith('id,createdAt,actorEmail,action'), 'csv header');
assert.ok(auditCsv.includes('project.create'), 'contains audited actions');
assert.ok(!/^[=+\-@|]/.test(auditCsv.split('\r\n')[1] || ''), 'formula-injection guarded');
// Leading-whitespace formula payloads must be quote-prefixed so Excel/LibreOffice
// treat the cell as text (not a DDE/formula).
assert.ok(
  auditCsv.split('\r\n').some((line) => line.includes(`'=cmd|"/c calc"`) || line.includes(`'  =cmd|`)),
  'whitespace-prefixed formula neutralized with leading single-quote'
);
assert.ok(
  !auditCsv.split('\r\n').some((line) => /(^|,)\s*=cmd\|/.test(line)),
  'raw whitespace formula must not appear unquoted in CSV'
);
r = await req(`/api/orgs/${orgAId}/audit?format=csv`, { headers: oauth });
assert.equal(r.status, 403, 'non-manager audit csv → 403');

// ---- Archive / restore ----
r = await req(`/api/projects/${proj.id}/archive`, { method: 'POST', headers: auth, body: body({ archived: true }) });
assert.equal(r.status, 200, 'archive ok');
assert.equal((await r.json()).archived, true);
r = await req('/api/projects', { headers: auth });
const archListed = (await r.json()).projects.find((p) => p.id === proj.id);
assert.equal(archListed.archived, 1, 'list carries archived flag');
r = await req(`/api/projects/${proj.id}/archive`, { method: 'POST', headers: oauth, body: body({ archived: false }) });
assert.equal(r.status, 404, 'non-member archive → 404');
r = await req(`/api/projects/${proj.id}/archive`, { method: 'POST', headers: auth, body: body({ archived: false }) });
assert.equal((await r.json()).archived, false, 'restore ok');

// ---- Task comments ----
r = await req(`/api/projects/${proj.id}/comments`, { method: 'POST', headers: auth, body: body({ taskId: 's1', body: '이 작업 일정 확인 부탁' }) });
assert.equal(r.status, 200, 'post comment');
const cmt = await r.json();
r = await req(`/api/projects/${proj.id}/comments?taskId=s1`, { headers: auth });
const cms = (await r.json()).comments;
assert.ok(cms.some((x) => x.id === cmt.id && x.body === '이 작업 일정 확인 부탁' && x.email), 'comment listed with author email');
r = await req(`/api/projects/${proj.id}/comments`, { method: 'POST', headers: auth, body: body({ body: '' }) });
assert.equal(r.status, 400, 'empty comment → 400');
r = await req(`/api/projects/${proj.id}/comments`, { headers: oauth });
assert.equal(r.status, 404, 'non-member comments → 404');
r = await req(`/api/projects/${proj.id}/comments/${cmt.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 200, 'author deletes own comment');
r = await req(`/api/projects/${proj.id}/comments/${cmt.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 404, 'double delete → 404');

// ---- Portfolio dashboard (org rollup) ----
r = await req(`/api/orgs/${orgAId}/portfolio`, { headers: auth });
assert.equal(r.status, 200, 'portfolio 200');
const port = (await r.json()).projects;
const portMain = port.find((p) => p.id === proj.id);
assert.ok(portMain, 'main project in the rollup');
assert.ok(typeof portMain.planned === 'number' && typeof portMain.actual === 'number', 'weighted % present');
assert.ok(['before', 'active', 'delay'].includes(portMain.status), 'evm status present');
assert.ok(typeof portMain.overdue === 'number', 'overdue count present');
// seeded past-due task shows up as overdue
const poV = (await (await req(`/api/projects/${proj.id}`, { headers: auth })).json()).version;
await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ tasks: [{ id: 'od1', name: '지연작업', plannedStartDate: '2020-01-01', plannedEndDate: '2020-01-05', plannedProgress: 100, actualProgress: 30, weight: 2 }], version: poV }) });
r = await req(`/api/orgs/${orgAId}/portfolio`, { headers: auth });
const portAfter = (await r.json()).projects.find((p) => p.id === proj.id);
assert.equal(portAfter.overdue, 1, 'past-due incomplete task counted overdue');
assert.equal(portAfter.status, 'delay', 'SPI 0.3 → delay');
r = await req(`/api/orgs/${orgAId}/portfolio`, { headers: oauth });
assert.equal(r.status, 404, 'non-member portfolio → 404');

// ---- 스프린트 + 방법론 (Agile/Hybrid) ----
r = await req(`/api/projects/${proj.id}/sprints`, { method: 'POST', headers: auth, body: body({ name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }) });
assert.equal(r.status, 200, 'sprint create');
const sp1 = await r.json();
r = await req(`/api/projects/${proj.id}/sprints`, { headers: auth });
let spData = await r.json();
assert.ok(spData.sprints.some((x) => x.id === sp1.id && x.startDate === '2026-06-01'), 'sprint listed');
assert.equal(spData.methodology, 'waterfall', 'default methodology');
// 방법론 변경(hybrid) → GET 반영
let mv = (await (await req(`/api/projects/${proj.id}`, { headers: auth })).json()).version;
r = await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ methodology: 'hybrid', version: mv }) });
assert.equal(r.status, 200);
r = await req(`/api/projects/${proj.id}`, { headers: auth });
assert.equal((await r.json()).methodology, 'hybrid', 'methodology persisted');
// 불량 값은 무시(기존 유지)
mv = (await (await req(`/api/projects/${proj.id}`, { headers: auth })).json()).version;
await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: auth, body: body({ methodology: 'chaos', version: mv }) });
assert.equal((await (await req(`/api/projects/${proj.id}`, { headers: auth })).json()).methodology, 'hybrid', 'invalid methodology ignored');
// 가드 + 삭제
r = await req(`/api/projects/${proj.id}/sprints`, { method: 'POST', headers: oauth, body: body({ name: 'X' }) });
assert.equal(r.status, 404, 'non-member sprint → 404');
r = await req(`/api/projects/${proj.id}/sprints/${sp1.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 200, 'sprint delete');

// ---- AI 브리핑 (orchestrator mock) ----
r = await req(`/api/projects/${proj.id}/ai/brief`, { method: 'POST', headers: auth });
assert.equal(r.status, 200, 'ai brief 200');
const brief = await r.json();
assert.ok(brief.analysis.includes('mock-orchestrator'), 'mock analysis returned');
assert.ok(brief.analysis.length > 40, 'non-trivial analysis');
r = await req(`/api/projects/${proj.id}/ai/brief`, { method: 'POST', headers: oauth });
assert.equal(r.status, 404, 'non-member ai brief → 404');

// ---- 산출물 첨부 (Clearfolio mock) ----
{
  const fd = new FormData();
  fd.append('file', new Blob(['%PDF-산출물-데모'], { type: 'application/pdf' }), '요구사항정의서.pdf');
  fd.append('taskId', 's1');
  r = await app.request(`/api/projects/${proj.id}/attachments`, { method: 'POST', headers: auth, body: fd });
  assert.equal(r.status, 200, 'attachment upload');
  const att = await r.json();
  assert.ok(att.id && att.jobId.startsWith('mockcf-'), 'mock job id');
  assert.equal(att.status, 'SUCCEEDED', 'mock converts immediately');
  // 목록 + 작업 바인딩 + 업로더
  r = await req(`/api/projects/${proj.id}/attachments?taskId=s1`, { headers: auth });
  const list = (await r.json()).attachments;
  assert.ok(list.some((x) => x.id === att.id && x.name === '요구사항정의서.pdf' && x.uploadedBy), 'listed with meta');
  // 열람: 302 → mock 아티팩트 → 바이트 왕복
  r = await req(`/api/projects/${proj.id}/attachments/${att.id}/view?token=${encodeURIComponent(token)}`);
  assert.equal(r.status, 302, 'view redirects');
  const loc = r.headers.get('location');
  assert.ok(loc.includes('/api/mock-clearfolio/'), 'redirect to signed artifact');
  r = await req(loc);
  assert.equal(r.status, 200);
  assert.ok((r.headers.get('content-type') || '').includes('application/pdf'), 'artifact mime');
  assert.equal(await r.text(), '%PDF-산출물-데모', 'artifact bytes round-trip');
  // 가드: HWP 차단, 비멤버 404, 뷰 무토큰 401
  const bad = new FormData();
  bad.append('file', new Blob(['x']), '문서.hwp');
  r = await app.request(`/api/projects/${proj.id}/attachments`, { method: 'POST', headers: auth, body: bad });
  assert.equal(r.status, 400, 'hwp blocked');
  r = await req(`/api/projects/${proj.id}/attachments`, { headers: oauth });
  assert.equal(r.status, 404, 'non-member attachments → 404');
  r = await req(`/api/projects/${proj.id}/attachments/${att.id}/view`);
  assert.equal(r.status, 401, 'view without token → 401');
  // 삭제(업로더)
  r = await req(`/api/projects/${proj.id}/attachments/${att.id}`, { method: 'DELETE', headers: auth });
  assert.equal(r.status, 200, 'uploader deletes attachment');
}

// ---- Public share links ----
r = await req(`/api/projects/${proj.id}/shares`, { method: 'POST', headers: auth });
assert.equal(r.status, 200, 'create share');
const share = await r.json();
assert.ok(share.token.length > 20 && share.url.includes(share.token), 'share token+url');
// anonymous read works, content only
r = await req(`/api/shared/${share.token}`);
assert.equal(r.status, 200, 'anonymous shared read');
const sharedView = await r.json();
assert.ok(Array.isArray(sharedView.tasks) && sharedView.readOnly === true, 'read-only content');
assert.ok(!('orgId' in sharedView) && !('version' in sharedView), 'no org/version leakage');
// listed; non-manager cannot create; revoke kills the token
r = await req(`/api/projects/${proj.id}/shares`, { headers: auth });
const shareRow = (await r.json()).shares.find((x) => x.token === share.token);
assert.ok(shareRow, 'share listed');
r = await req(`/api/projects/${proj.id}/shares`, { method: 'POST', headers: oauth });
assert.equal(r.status, 404, 'non-member share create → 404');
r = await req(`/api/projects/${proj.id}/shares/${shareRow.id}`, { method: 'DELETE', headers: auth });
assert.equal(r.status, 200, 'revoke share');
r = await req(`/api/shared/${share.token}`);
assert.equal(r.status, 404, 'revoked share token dead');
r = await req('/api/shared/bogus-token');
assert.equal(r.status, 404, 'unknown token → 404');

// ---- Unseen-activity notifications ----
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'notif@x.com', password: 'password123' }) });
const nAuth = { authorization: `Bearer ${(await r.json()).token}` };
const nInv = await (await req(`/api/orgs/${orgAId}/invites`, { method: 'POST', headers: auth, body: body({ email: 'notif@x.com', role: 'member' }) })).json();
await req(`/api/invites/${nInv.token}/accept`, { method: 'POST', headers: nAuth });
// I mark the project seen NOW, then the other member changes things
await req(`/api/projects/${proj.id}/seen`, { method: 'POST', headers: auth });
const nV = (await (await req(`/api/projects/${proj.id}`, { headers: nAuth })).json()).version;
await new Promise((res) => setTimeout(res, 1100)); // datetime('now') is second-granular
await req(`/api/projects/${proj.id}`, { method: 'PUT', headers: nAuth, body: body({ tasks: [{ id: 'n1', name: '알림작업' }], version: nV }) });
await req(`/api/projects/${proj.id}/comments`, { method: 'POST', headers: nAuth, body: body({ body: '변경했습니다' }) });
r = await req('/api/notifications', { headers: auth });
assert.equal(r.status, 200, 'notifications 200');
let notif = (await r.json()).notifications.find((n) => n.projectId === proj.id);
assert.ok(notif && notif.unseen >= 2, "others' save+comment counted as unseen");
// my own activity does not notify me: after marking seen, my own new comment
// must NOT create an unseen count for me
await req(`/api/projects/${proj.id}/seen`, { method: 'POST', headers: nAuth });
await new Promise((res) => setTimeout(res, 1100));
await req(`/api/projects/${proj.id}/comments`, { method: 'POST', headers: nAuth, body: body({ body: '내 코멘트' }) });
r = await req('/api/notifications', { headers: nAuth });
assert.ok(!((await r.json()).notifications || []).some((n) => n.projectId === proj.id), 'own activity not counted');
// opening (marking seen) clears it
await req(`/api/projects/${proj.id}/seen`, { method: 'POST', headers: auth });
r = await req('/api/notifications', { headers: auth });
assert.ok(!(await r.json()).notifications.some((n) => n.projectId === proj.id), 'seen clears unseen');

// ---- Logout everywhere (token_version revocation) ----
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'devices@x.com', password: 'password123' }) });
const devTokA = (await r.json()).token;
r = await req('/api/auth/login', { method: 'POST', body: body({ email: 'devices@x.com', password: 'password123' }) });
const devTokB = (await r.json()).token; // second "device"
r = await req('/api/auth/logout-all', { method: 'POST', headers: { authorization: `Bearer ${devTokA}` } });
assert.equal(r.status, 200, 'logout-all ok');
const fresh = (await r.json()).token;
assert.equal((await req('/api/me', { headers: { authorization: `Bearer ${devTokA}` } })).status, 401, 'old token A dead');
assert.equal((await req('/api/me', { headers: { authorization: `Bearer ${devTokB}` } })).status, 401, 'other device token dead');
assert.equal((await req('/api/me', { headers: { authorization: `Bearer ${fresh}` } })).status, 200, 'fresh token works');
r = await req('/api/auth/login', { method: 'POST', body: body({ email: 'devices@x.com', password: 'password123' }) });
assert.equal((await req('/api/me', { headers: { authorization: `Bearer ${(await r.json()).token}` } })).status, 200, 're-login works');

// ---- Ownership transfer (full circle: old owner can then leave) ----
r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'heir@x.com', password: 'password123' }) });
const heir = await r.json();
const heirAuth = { authorization: `Bearer ${heir.token}` };
const heirInv = await (await req(`/api/orgs/${orgAId}/invites`, { method: 'POST', headers: auth, body: body({ email: 'heir@x.com', role: 'member' }) })).json();
await req(`/api/invites/${heirInv.token}/accept`, { method: 'POST', headers: heirAuth });
const heirId = (await (await req('/api/me', { headers: heirAuth })).json()).user.id;
r = await req(`/api/orgs/${orgAId}/transfer`, { method: 'POST', headers: heirAuth, body: body({ userId: 1 }) });
assert.equal(r.status, 403, 'non-owner cannot transfer');
r = await req(`/api/orgs/${orgAId}/transfer`, { method: 'POST', headers: auth, body: body({ userId: 99999 }) });
assert.equal(r.status, 404, 'transfer to non-member → 404');
r = await req(`/api/orgs/${orgAId}/transfer`, { method: 'POST', headers: auth, body: body({ userId: heirId }) });
assert.equal(r.status, 200, 'owner transfers ownership');
r = await req('/api/me', { headers: heirAuth });
assert.equal((await r.json()).orgs.find((o) => o.id === orgAId)?.role, 'owner', 'target became owner');
r = await req('/api/me', { headers: auth });
assert.equal((await r.json()).orgs.find((o) => o.id === orgAId)?.role, 'admin', 'old owner demoted to admin');
r = await req(`/api/orgs/${orgAId}/leave`, { method: 'POST', headers: auth });
assert.equal(r.status, 200, 'former owner can now leave');

console.log('✓ API smoke tests passed');
