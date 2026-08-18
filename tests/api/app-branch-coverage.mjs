// Branch-oriented API coverage for production control-flow alternatives that
// are easy to miss in happy-path smoke tests. The cases use public HTTP
// boundaries wherever behavior is observable and bounded SQLite fault
// injection only for explicit "must not break the operation"/rollback paths.
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '1000';
process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
delete process.env.ORCHESTRATOR_URL;
delete process.env.CLEARFOLIO_URL;
delete process.env.OIDC_ISSUER;

const [{ app }, { db }, { signToken }] = await Promise.all([
  import('../../server/app.mjs'),
  import('../../server/db.mjs'),
  import('../../server/auth.mjs'),
]);

const jsonBody = (value) => JSON.stringify(value);
const authHeaders = (token) => ({ authorization: `Bearer ${token}` });
const req = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return app.request(path, { ...options, headers });
};
const malformedJson = (path, method, headers = {}) =>
  req(path, { method, headers, body: '{' });
const status = async (expected, promise, label) => {
  const response = await promise;
  assert.equal(response.status, expected, label);
  return response;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timeout waiting for ${label}`);
};

// JSON parse failures are user-input branches, not exceptional test setup.
await status(400, malformedJson('/api/auth/signup', 'POST'), 'malformed signup');
await status(401, malformedJson('/api/auth/login', 'POST'), 'malformed login');

let response = await req('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'branch-owner@example.com', password: 'password123', name: 'Branch Owner' }),
});
assert.equal(response.status, 200);
const ownerToken = (await response.json()).token;
const ownerAuth = authHeaders(ownerToken);
response = await req('/api/me', { headers: ownerAuth });
const ownerMe = await response.json();
const ownerId = ownerMe.user.id;
const orgId = ownerMe.orgs[0].id;
db.prepare("UPDATE orgs SET plan = 'pro' WHERE id = ?").run(orgId);

// Version-zero accounts still exercise the explicit `payload.tv || 0` branch,
// while the hardened signer/verifier contract requires token-version metadata.
const versionZeroToken = signToken({ sub: ownerId, email: ownerMe.user.email, tv: 0 });
await status(200, req('/api/me', { headers: authHeaders(versionZeroToken) }), 'version-zero JWT');

response = await req('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'branch-member@example.com', password: 'password123' }),
});
const memberToken = (await response.json()).token;
const memberAuth = authHeaders(memberToken);
const memberId = (await (await req('/api/me', { headers: memberAuth })).json()).user.id;
db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(orgId, memberId, 'viewer');

await status(400, malformedJson('/api/orgs', 'POST', ownerAuth), 'malformed org create');
await status(400, malformedJson('/api/projects', 'POST', ownerAuth), 'malformed project create');
response = await req('/api/projects', {
  method: 'POST',
  headers: ownerAuth,
  body: jsonBody({ name: 'Branch Project', orgId }),
});
assert.equal(response.status, 200);
const projectId = (await response.json()).id;

// Malformed/partial updates exercise persisted-value and methodology fallbacks.
await status(200, malformedJson(`/api/projects/${projectId}`, 'PUT', ownerAuth), 'malformed update falls back');
let project = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
response = await req(`/api/projects/${projectId}`, {
  method: 'PUT',
  headers: ownerAuth,
  body: jsonBody({
    version: project.version,
    name: 'Renamed Branch Project',
    baseDate: '2026-08-18',
    methodology: 'agile',
    tasks: [
      { id: 'late-name', name: 'Late named', plannedEndDate: '2020-01-01', actualProgress: 40, plannedProgress: 100, weight: 2, owner: 'A' },
      { id: 'late-task', task: 'Late task fallback', plannedEndDate: '2020-01-02', actualProgress: 0 },
      { id: 'future-activity', activity: 'Activity fallback', plannedStartDate: '2999-01-01', plannedEndDate: '2999-01-02' },
      { id: 'future-phase', phase: 'Phase fallback', plannedStartDate: '2999-02-01', plannedEndDate: '2999-02-02' },
      { id: 'future-id', plannedStartDate: '2999-03-01', plannedEndDate: '2999-03-02' },
    ],
  }),
});
assert.equal(response.status, 200);

// Revision-history persistence is deliberately best-effort. A storage fault in
// that side channel must not turn an otherwise valid save into a failed save.
db.exec("CREATE TEMP TRIGGER fail_revision_insert BEFORE INSERT ON project_revisions BEGIN SELECT RAISE(ABORT, 'forced revision failure'); END");
project = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
await status(200, req(`/api/projects/${projectId}`, {
  method: 'PUT', headers: ownerAuth, body: jsonBody({ version: project.version, name: 'History fault tolerated' }),
}), 'revision insert failure is contained');
db.exec('DROP TRIGGER fail_revision_insert');

// Comment deletion covers author, manager-of-another-author, and forbidden
// non-manager alternatives.
db.prepare("UPDATE memberships SET role = 'member' WHERE org_id = ? AND user_id = ?").run(orgId, memberId);
response = await req(`/api/projects/${projectId}/comments`, {
  method: 'POST', headers: memberAuth, body: jsonBody({ taskId: 'task-1', body: 'member comment' }),
});
const memberCommentId = (await response.json()).id;
await status(200, req(`/api/projects/${projectId}/comments/${memberCommentId}`, { method: 'DELETE', headers: ownerAuth }), 'manager deletes another comment');
response = await req(`/api/projects/${projectId}/comments`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({ body: 'owner comment' }),
});
const ownerCommentId = (await response.json()).id;
await status(403, req(`/api/projects/${projectId}/comments/${ownerCommentId}`, { method: 'DELETE', headers: memberAuth }), 'member cannot delete another comment');
await status(400, malformedJson(`/api/projects/${projectId}/comments`, 'POST', ownerAuth), 'malformed comment');

// Viewer-specific write guards differ from cross-tenant 404 behavior.
db.prepare("UPDATE memberships SET role = 'viewer' WHERE org_id = ? AND user_id = ?").run(orgId, memberId);
await status(403, req(`/api/projects/${projectId}`, { method: 'PUT', headers: memberAuth, body: jsonBody({}) }), 'viewer project write');
await status(403, req(`/api/projects/${projectId}/revisions/1/restore`, { method: 'POST', headers: memberAuth }), 'viewer restore');

// Calendar: invalid PAT, corrupted task JSON fallback, and JWT-header auth.
await status(401, req(`/api/projects/${projectId}/calendar.ics`, { headers: authHeaders('swk_invalid') }), 'invalid calendar PAT');
const savedTasksJson = db.prepare('SELECT tasks_json FROM projects WHERE id = ?').get(projectId).tasks_json;
db.prepare('UPDATE projects SET tasks_json = ? WHERE id = ?').run('{bad-json', projectId);
await status(200, req(`/api/projects/${projectId}/calendar.ics`, { headers: ownerAuth }), 'calendar corrupted task storage');
db.prepare('UPDATE projects SET tasks_json = ? WHERE id = ?').run(savedTasksJson, projectId);

// SSE: bearer auth, missing project, existing subscriber-set path, dropped
// subscriber enqueue containment, and already-closed abort cleanup.
await status(404, req('/api/projects/999999/stream', { headers: ownerAuth }), 'SSE missing project');
const abortController = new AbortController();
const streamRequest = new Request(`http://localhost/api/projects/${projectId}/stream`, {
  headers: ownerAuth,
  signal: abortController.signal,
});
const streamResponse = await app.request(streamRequest);
assert.equal(streamResponse.status, 200);
const secondStream = await req(`/api/projects/${projectId}/stream`, { headers: ownerAuth });
assert.equal(secondStream.status, 200);
await streamResponse.body?.cancel();
project = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
await status(200, req(`/api/projects/${projectId}`, {
  method: 'PUT', headers: ownerAuth, body: jsonBody({ version: project.version }),
}), 'broadcast tolerates dropped subscriber');
abortController.abort();
await delay(0);
await secondStream.body?.cancel();

// Membership/organization validation branches.
await status(404, req('/api/orgs/999999/members', { headers: ownerAuth }), 'unknown roster');
await status(403, malformedJson(`/api/orgs/${orgId}/invites`, 'POST', memberAuth), 'viewer invite forbidden');
await status(400, req(`/api/orgs/${orgId}/invites`, { method: 'POST', headers: ownerAuth, body: jsonBody({ email: 'x@example.com', role: 'owner' }) }), 'invalid invite role');
response = await req(`/api/orgs/${orgId}/invites`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({ email: ownerMe.user.email }),
});
const existingInvite = await response.json();
response = await req(`/api/invites/${existingInvite.token}/accept`, { method: 'POST', headers: ownerAuth });
assert.equal(response.status, 200);
assert.equal((await response.json()).role, 'owner');
await status(400, malformedJson(`/api/orgs/${orgId}/members/${memberId}`, 'PATCH', ownerAuth), 'malformed role change');
await status(404, req(`/api/orgs/${orgId}/members/999999`, { method: 'PATCH', headers: ownerAuth, body: jsonBody({ role: 'member' }) }), 'unknown role target');
await status(404, req(`/api/orgs/${orgId}/members/999999`, { method: 'DELETE', headers: ownerAuth }), 'unknown member removal');
await status(400, malformedJson(`/api/orgs/${orgId}/transfer`, 'POST', ownerAuth), 'missing transfer target');
await status(400, req(`/api/orgs/${orgId}/transfer`, { method: 'POST', headers: ownerAuth, body: jsonBody({ userId: ownerId }) }), 'self transfer');
await status(400, malformedJson(`/api/orgs/${orgId}`, 'PATCH', ownerAuth), 'malformed org rename');
await status(403, req(`/api/orgs/${orgId}/checkout`, { method: 'POST', headers: memberAuth }), 'non-owner checkout');

// The dev-only activation route is evaluated at request time; production mode
// must hide it even when the app was imported for development tests.
process.env.SCOPEWEAVE_DEV = '0';
await status(404, req(`/api/orgs/${orgId}/_dev/activate-pro`, { method: 'POST', headers: ownerAuth }), 'dev route disabled');
process.env.SCOPEWEAVE_DEV = '1';
await status(403, req(`/api/orgs/${orgId}/_dev/activate-pro`, { method: 'POST', headers: memberAuth }), 'dev route owner-only');

// Stripe webhook input optionality and JSON parse fallback.
await status(200, malformedJson('/api/stripe/webhook', 'POST'), 'malformed Stripe event');
await status(200, req('/api/stripe/webhook', { method: 'POST', body: jsonBody({ type: 'checkout.session.completed', data: {} }) }), 'Stripe event without object');
await status(200, req('/api/stripe/webhook', { method: 'POST', body: jsonBody({ type: 'checkout.session.completed', data: { object: {} } }) }), 'Stripe event without org id');

// PAT defaults plus owner/admin audit/export guards.
response = await malformedJson('/api/tokens', 'POST', ownerAuth);
assert.equal(response.status, 200);
const unnamedPat = await response.json();
assert.equal(unnamedPat.name, 'token');
await status(403, req(`/api/orgs/${orgId}/audit`, { headers: memberAuth }), 'member audit forbidden');
await status(403, req(`/api/orgs/${orgId}/export`, { headers: memberAuth }), 'member export forbidden');

// Webhook event-subscription alternatives: wildcard delivers, unrelated events
// skip, string events are accepted, and delivery-record failures are contained.
const nativeFetch = globalThis.fetch;
let webhookFetches = 0;
globalThis.fetch = async (url) => {
  webhookFetches += 1;
  if (String(url).endsWith('/string')) await delay(20);
  return new Response(null, { status: 204 });
};
response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({ url: 'https://hooks.example.test/wildcard' }),
});
const wildcardWebhook = await response.json();
response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({ url: 'https://hooks.example.test/string', events: 'project.update' }),
});
const stringWebhook = await response.json();
await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({ url: 'https://hooks.example.test/skip', events: ['member.join'] }),
});
await status(400, malformedJson(`/api/orgs/${orgId}/webhooks`, 'POST', ownerAuth), 'malformed webhook');
const stringDeliveriesBefore = db.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries WHERE webhook_id = ?').get(stringWebhook.id).count;
db.exec(`CREATE TEMP TRIGGER fail_delivery_insert BEFORE INSERT ON webhook_deliveries
  WHEN NEW.webhook_id = ${Number(wildcardWebhook.id)}
  BEGIN SELECT RAISE(ABORT, 'forced delivery record failure'); END`);
project = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
await status(200, req(`/api/projects/${projectId}`, {
  method: 'PUT', headers: ownerAuth, body: jsonBody({ version: project.version }),
}), 'webhook record failure is contained');
await waitFor(
  () => db.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries WHERE webhook_id = ?').get(stringWebhook.id).count > stringDeliveriesBefore,
  'sibling webhook delivery after injected record failure',
);
db.exec('DROP TRIGGER fail_delivery_insert');

// Force only the delivery lookup boundary to disappear. The project update is
// still authoritative and must succeed because webhook delivery is best-effort.
const fetchesBeforeUnavailable = webhookFetches;
db.exec('ALTER TABLE webhooks RENAME TO webhooks_temporarily_unavailable');
try {
  project = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
  await status(200, req(`/api/projects/${projectId}`, {
    method: 'PUT', headers: ownerAuth, body: jsonBody({ version: project.version }),
  }), 'missing webhook table is contained');
} finally {
  db.exec('ALTER TABLE webhooks_temporarily_unavailable RENAME TO webhooks');
}
assert.equal(webhookFetches, fetchesBeforeUnavailable, 'missing webhook table schedules no delivery');
globalThis.fetch = nativeFetch;
await status(404, req(`/api/orgs/${orgId}/webhooks/999999/deliveries`, { headers: ownerAuth }), 'unknown delivery history');
await status(200, req(`/api/orgs/${orgId}/webhooks/${wildcardWebhook.id}`, { method: 'DELETE', headers: ownerAuth }), 'delete wildcard webhook');
await status(200, req(`/api/orgs/${orgId}/webhooks/${stringWebhook.id}`, { method: 'DELETE', headers: ownerAuth }), 'delete string webhook');

// OIDC default-email and expiration branches in the self-contained provider.
let oidcStart = await req('/api/auth/oidc/start');
let oidcAuthorizeUrl = new URL(oidcStart.headers.get('location'));
assert.equal(oidcAuthorizeUrl.searchParams.get('email'), 'sso-user@example.com');
const expiringState = oidcAuthorizeUrl.searchParams.get('state');
const nativeNow = Date.now;
Date.now = () => nativeNow() + (10 * 60 * 1000);
try {
  await status(400, req(`/api/auth/oidc/callback?state=${expiringState}&code=anything`), 'expired OIDC state');
} finally {
  Date.now = nativeNow;
}

// Search branch caps: five task hits per project and twenty projects per query.
const manyTasks = Array.from({ length: 6 }, (_, index) => ({ id: `needle-${index}`, name: `Needle task ${index}` }));
db.prepare('UPDATE projects SET tasks_json = ? WHERE id = ?').run(JSON.stringify(manyTasks), projectId);
response = await req('/api/search?q=Needle', { headers: ownerAuth });
assert.equal(response.status, 200);
assert.equal((await response.json()).results.find((item) => item.projectId === projectId).tasks.length, 5);
await status(400, req('/api/search', { headers: ownerAuth }), 'missing search query');
const insertProject = db.prepare('INSERT INTO projects(org_id,name,created_by) VALUES(?,?,?)');
for (let index = 0; index < 21; index += 1) insertProject.run(orgId, `BulkSearch ${index}`, ownerId);
response = await req('/api/search?q=BulkSearch', { headers: ownerAuth });
assert.equal((await response.json()).results.length, 20);

// AI summary task-name and progress fallbacks were seeded above; restore them
// and execute the real public route so each branch contributes to one briefing.
db.prepare('UPDATE projects SET tasks_json = ? WHERE id = ?').run(savedTasksJson, projectId);
await status(200, req(`/api/projects/${projectId}/ai/brief`, { method: 'POST', headers: ownerAuth, body: jsonBody({}) }), 'AI fallback briefing');

// Attachment validation: malformed multipart, string field instead of File,
// empty MIME/taskId defaults, size ceiling, viewer write guard, readiness/notfound
// view paths, and uploader-vs-manager delete authorization.
await status(400, req(`/api/projects/${projectId}/attachments`, { method: 'POST', headers: ownerAuth, body: 'not-multipart' }), 'malformed attachment form');
const stringFile = new FormData();
stringFile.append('file', 'plain-text-field');
await status(400, app.request(`/api/projects/${projectId}/attachments`, { method: 'POST', headers: ownerAuth, body: stringFile }), 'string attachment field');
const emptyMime = new FormData();
emptyMime.append('file', new Blob(['document']), 'document.bin');
response = await app.request(`/api/projects/${projectId}/attachments`, { method: 'POST', headers: ownerAuth, body: emptyMime });
assert.equal(response.status, 200);
const ownerAttachmentId = (await response.json()).id;
const oversized = new FormData();
oversized.append('file', new Blob([new Uint8Array((10 * 1024 * 1024) + 1)]), 'oversized.pdf');
await status(400, app.request(`/api/projects/${projectId}/attachments`, { method: 'POST', headers: ownerAuth, body: oversized }), 'attachment size ceiling');
await status(403, app.request(`/api/projects/${projectId}/attachments`, { method: 'POST', headers: memberAuth, body: emptyMime }), 'viewer upload forbidden');
await status(404, req(`/api/projects/${projectId}/attachments/999999/view`, { headers: ownerAuth }), 'missing attachment view');
db.prepare('UPDATE attachments SET status = ? WHERE id = ?').run('PENDING', ownerAttachmentId);
await status(409, req(`/api/projects/${projectId}/attachments/${ownerAttachmentId}/view`, { headers: ownerAuth }), 'pending attachment view');
db.prepare('UPDATE attachments SET status = ? WHERE id = ?').run('SUCCEEDED', ownerAttachmentId);

// Member uploads a document; another member cannot delete it, while the owner can.
db.prepare("UPDATE memberships SET role = 'member' WHERE org_id = ? AND user_id = ?").run(orgId, memberId);
const memberUpload = new FormData();
memberUpload.append('file', new Blob(['member document'], { type: 'application/pdf' }), 'member.pdf');
response = await app.request(`/api/projects/${projectId}/attachments`, { method: 'POST', headers: memberAuth, body: memberUpload });
const memberAttachmentId = (await response.json()).id;
response = await req('/api/auth/signup', { method: 'POST', body: jsonBody({ email: 'branch-peer@example.com', password: 'password123' }) });
const peerAuth = authHeaders((await response.json()).token);
const peerId = (await (await req('/api/me', { headers: peerAuth })).json()).user.id;
db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(orgId, peerId, 'member');
await status(403, req(`/api/projects/${projectId}/attachments/${memberAttachmentId}`, { method: 'DELETE', headers: peerAuth }), 'peer cannot delete attachment');
await status(200, req(`/api/projects/${projectId}/attachments/${memberAttachmentId}`, { method: 'DELETE', headers: ownerAuth }), 'manager deletes member attachment');
await status(404, req('/api/mock-clearfolio/not-a-job'), 'missing mock artifact');

// Share, seen, archive, duplicate, sprint, baseline, and project lifecycle guard
// branches that differ for viewers versus non-members.
db.prepare("UPDATE memberships SET role = 'viewer' WHERE org_id = ? AND user_id = ?").run(orgId, memberId);
await status(403, req(`/api/projects/${projectId}/shares`, { method: 'POST', headers: memberAuth }), 'viewer share create');
await status(403, req(`/api/projects/${projectId}/shares`, { headers: memberAuth }), 'viewer share list');
await status(404, req(`/api/projects/${projectId}/shares/999999`, { method: 'DELETE', headers: ownerAuth }), 'unknown share revoke');
await status(404, req('/api/projects/999999/seen', { method: 'POST', headers: ownerAuth }), 'seen missing project');
await status(403, malformedJson(`/api/projects/${projectId}/archive`, 'POST', memberAuth), 'viewer archive');
await status(200, malformedJson(`/api/projects/${projectId}/archive`, 'POST', ownerAuth), 'archive default true');
await status(403, malformedJson(`/api/projects/${projectId}/duplicate`, 'POST', memberAuth), 'viewer duplicate');
await status(200, malformedJson(`/api/projects/${projectId}/duplicate`, 'POST', ownerAuth), 'duplicate default name');
await status(403, malformedJson(`/api/projects/${projectId}/sprints`, 'POST', memberAuth), 'viewer sprint');
await status(400, malformedJson(`/api/projects/${projectId}/sprints`, 'POST', ownerAuth), 'malformed sprint');
response = await req(`/api/projects/${projectId}/sprints`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({ name: 'Invalid dates', startDate: 'not-a-date', endDate: '', goal: '' }),
});
assert.equal(response.status, 200);
const sprintId = (await response.json()).id;
await status(404, req(`/api/projects/${projectId}/sprints/999999`, { method: 'DELETE', headers: ownerAuth }), 'unknown sprint delete');
await status(200, req(`/api/projects/${projectId}/sprints/${sprintId}`, { method: 'DELETE', headers: ownerAuth }), 'sprint delete');
await status(403, malformedJson(`/api/projects/${projectId}/baselines`, 'POST', memberAuth), 'viewer baseline');
response = await malformedJson(`/api/projects/${projectId}/baselines`, 'POST', ownerAuth);
assert.equal(response.status, 200);
const baselineId = (await response.json()).id;
await status(404, req(`/api/projects/${projectId}/baselines/999999`, { headers: ownerAuth }), 'unknown baseline get');
await status(404, req(`/api/projects/${projectId}/baselines/999999`, { method: 'DELETE', headers: ownerAuth }), 'unknown baseline delete');
await status(200, req(`/api/projects/${projectId}/baselines/${baselineId}`, { method: 'DELETE', headers: ownerAuth }), 'baseline delete');
await status(403, req(`/api/projects/${projectId}`, { method: 'DELETE', headers: memberAuth }), 'viewer project delete');
await status(404, req('/api/projects/999999', { method: 'DELETE', headers: ownerAuth }), 'missing project delete');

// Best-effort audit writes are contained if the audit store rejects one event.
db.exec("CREATE TEMP TRIGGER fail_audit_insert BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END");
await status(200, req(`/api/projects/${projectId}/archive`, { method: 'POST', headers: ownerAuth, body: jsonBody({ archived: false }) }), 'audit failure is contained');
db.exec('DROP TRIGGER fail_audit_insert');

// Transactional rollback branches: membership creation failure during signup
// and org creation, transfer update failure, and account-delete failure.
db.exec("CREATE TEMP TRIGGER fail_membership_insert BEFORE INSERT ON memberships BEGIN SELECT RAISE(ABORT, 'forced membership insert failure'); END");
await status(500, req('/api/auth/signup', { method: 'POST', body: jsonBody({ email: 'rollback-signup@example.com', password: 'password123' }) }), 'signup rollback');
await status(500, req('/api/orgs', { method: 'POST', headers: ownerAuth, body: jsonBody({ name: 'Rollback Org' }) }), 'org rollback');
db.exec('DROP TRIGGER fail_membership_insert');
assert.equal(db.prepare('SELECT id FROM users WHERE email = ?').get('rollback-signup@example.com'), undefined);

// Prepare an ordinary member as the ownership-transfer target.
db.prepare("UPDATE memberships SET role = 'member' WHERE org_id = ? AND user_id = ?").run(orgId, memberId);
db.exec("CREATE TEMP TRIGGER fail_membership_update BEFORE UPDATE ON memberships BEGIN SELECT RAISE(ABORT, 'forced membership update failure'); END");
await status(500, req(`/api/orgs/${orgId}/transfer`, { method: 'POST', headers: ownerAuth, body: jsonBody({ userId: memberId }) }), 'transfer rollback');
db.exec('DROP TRIGGER fail_membership_update');
assert.equal(db.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, ownerId).role, 'owner');

response = await req('/api/auth/signup', { method: 'POST', body: jsonBody({ email: 'rollback-account@example.com', password: 'password123' }) });
const rollbackAccountToken = (await response.json()).token;
const rollbackAccountId = (await (await req('/api/me', { headers: authHeaders(rollbackAccountToken) })).json()).user.id;
db.exec("CREATE TEMP TRIGGER fail_org_delete BEFORE DELETE ON orgs BEGIN SELECT RAISE(ABORT, 'forced org delete failure'); END");
await status(500, req('/api/account', { method: 'DELETE', headers: authHeaders(rollbackAccountToken), body: jsonBody({ password: 'password123' }) }), 'account delete rollback');
db.exec('DROP TRIGGER fail_org_delete');
assert.ok(db.prepare('SELECT id FROM users WHERE id = ?').get(rollbackAccountId));
await status(200, req('/api/account', { method: 'DELETE', headers: authHeaders(rollbackAccountToken), body: jsonBody({ password: 'password123' }) }), 'account delete after rollback');

// Restore-history catch: build a valid revision, then reject only the new
// history snapshot while allowing the project restore itself to succeed.
project = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
await req(`/api/projects/${projectId}`, { method: 'PUT', headers: ownerAuth, body: jsonBody({ version: project.version, name: 'Restore source' }) });
const restoreVersion = (await (await req(`/api/projects/${projectId}/revisions`, { headers: ownerAuth })).json()).revisions[0].version;
db.exec("CREATE TEMP TRIGGER fail_restore_revision BEFORE INSERT ON project_revisions BEGIN SELECT RAISE(ABORT, 'forced restore history failure'); END");
await status(200, req(`/api/projects/${projectId}/revisions/${restoreVersion}/restore`, { method: 'POST', headers: ownerAuth }), 'restore history failure is contained');
db.exec('DROP TRIGGER fail_restore_revision');

await status(400, malformedJson('/api/auth/change-password', 'POST', ownerAuth), 'malformed password change');
await status(403, malformedJson('/api/account', 'DELETE', ownerAuth), 'malformed account delete');
await status(404, req('/definitely-not-a-static-route'), 'unknown static route');

console.log('app branch coverage: ok');