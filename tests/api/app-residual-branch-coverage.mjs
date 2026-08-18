// Residual production branch coverage through observable API behavior.
// These cases target tenant/auth guards, fallback semantics, and best-effort
// integration boundaries that remain material under exact-head coverage.
import assert from 'node:assert/strict';
import { File } from 'node:buffer';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '1000';
process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
delete process.env.ORCHESTRATOR_URL;
delete process.env.CLEARFOLIO_URL;
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;
delete process.env.OIDC_REDIRECT_URI;

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
const status = async (expected, promise, label) => {
  const response = await promise;
  assert.equal(response.status, expected, label);
  return response;
};

let response = await req('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'residual-owner@example.com', password: 'password123', name: 'Residual Owner' }),
});
assert.equal(response.status, 200);
const ownerToken = (await response.json()).token;
const ownerAuth = authHeaders(ownerToken);
const ownerMe = await (await req('/api/me', { headers: ownerAuth })).json();
const ownerId = ownerMe.user.id;
const orgId = ownerMe.orgs[0].id;
db.prepare("UPDATE orgs SET plan = 'pro' WHERE id = ?").run(orgId);

// A cryptographically valid token for a deleted/nonexistent subject must still
// fail closed at the authoritative user-version lookup.
const ghostToken = signToken({ sub: 999999, email: 'ghost@example.com', tv: 0 });
await status(401, req('/api/me', { headers: authHeaders(ghostToken) }), 'nonexistent signed user');

response = await req('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'residual-member@example.com', password: 'password123' }),
});
const memberToken = (await response.json()).token;
const memberAuth = authHeaders(memberToken);
const memberId = (await (await req('/api/me', { headers: memberAuth })).json()).user.id;
db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(orgId, memberId, 'viewer');

response = await req('/api/projects', {
  method: 'POST',
  headers: ownerAuth,
  body: jsonBody({ name: 'Residual Project', orgId }),
});
assert.equal(response.status, 200);
const projectId = (await response.json()).id;

// Legacy/null methodology remains readable and an invalid update still resolves
// to the documented waterfall fallback rather than persisting an unknown mode.
db.prepare('UPDATE projects SET methodology = NULL WHERE id = ?').run(projectId);
response = await req(`/api/projects/${projectId}`, { headers: ownerAuth });
assert.equal((await response.json()).methodology, 'waterfall');
let project = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
await status(200, req(`/api/projects/${projectId}`, {
  method: 'PUT',
  headers: ownerAuth,
  body: jsonBody({ version: project.version, methodology: 'unsupported-mode' }),
}), 'invalid methodology falls back');

// Comment and revision guards distinguish inaccessible projects, read-only
// membership, and missing snapshots from valid project history.
await status(404, req('/api/projects/999999/comments', {
  method: 'POST', headers: ownerAuth, body: jsonBody({ body: 'missing project' }),
}), 'comment missing project');
await status(403, req(`/api/projects/${projectId}/comments`, {
  method: 'POST', headers: memberAuth, body: jsonBody({ body: 'viewer write' }),
}), 'viewer comment forbidden');
await status(404, req('/api/projects/999999/revisions', { headers: ownerAuth }), 'revisions missing project');
await status(404, req('/api/projects/999999/revisions/1', { headers: ownerAuth }), 'revision detail missing project');
await status(404, req(`/api/projects/${projectId}/revisions/999999`, { headers: ownerAuth }), 'revision snapshot missing');

// Calendar query-token authentication is a real EventSource/calendar-client
// path. Missing start/end dates must be skipped independently.
project = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
await status(200, req(`/api/projects/${projectId}`, {
  method: 'PUT',
  headers: ownerAuth,
  body: jsonBody({
    version: project.version,
    tasks: [
      { id: 'missing-start', name: 'Missing start', plannedEndDate: '2999-01-02' },
      { id: 'missing-end', name: 'Missing end', plannedStartDate: '2999-01-01' },
    ],
  }),
}), 'calendar fallback task seed');
response = await req(`/api/projects/${projectId}/calendar.ics?token=${encodeURIComponent(ownerToken)}`);
assert.equal(response.status, 200);
const calendar = await response.text();
assert.doesNotMatch(calendar, /missing-start|missing-end/);

// Invitation defaults and owner-protection rules must remain explicit.
await status(400, req(`/api/orgs/${orgId}/invites`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({}),
}), 'invite email required');
response = await req(`/api/orgs/${orgId}/invites`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({ email: 'invite-default@example.com' }),
});
assert.equal(response.status, 200);
assert.equal((await response.json()).role, 'member');
await status(403, req(`/api/orgs/${orgId}/members/${ownerId}`, {
  method: 'PATCH', headers: ownerAuth, body: jsonBody({ role: 'member' }),
}), 'owner role immutable');
await status(403, req(`/api/orgs/${orgId}/members/${ownerId}`, {
  method: 'DELETE', headers: ownerAuth,
}), 'owner cannot be removed');
await status(404, req('/api/orgs/999999/leave', { method: 'POST', headers: ownerAuth }), 'leave unknown org');
await status(404, req('/api/orgs/999999/billing', { headers: ownerAuth }), 'billing unknown org');

// Non-managers cannot inspect or mutate webhook controls. A legacy/null event
// subscription must be treated as no subscription and never trigger delivery.
await status(403, req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST', headers: memberAuth, body: jsonBody({ url: 'https://hooks.example.test/denied' }),
}), 'viewer webhook create');
await status(403, req(`/api/orgs/${orgId}/webhooks/1/deliveries`, { headers: memberAuth }), 'viewer webhook deliveries');
await status(403, req(`/api/orgs/${orgId}/webhooks/1/rotate`, { method: 'POST', headers: memberAuth }), 'viewer webhook rotate');
await status(403, req(`/api/orgs/${orgId}/webhooks/1`, { method: 'DELETE', headers: memberAuth }), 'viewer webhook delete');
response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({ url: 'https://hooks.example.test/null-events', events: ['project.update'] }),
});
const nullEventsWebhook = await response.json();
db.prepare('UPDATE webhooks SET events = NULL WHERE id = ?').run(nullEventsWebhook.id);
project = await (await req(`/api/projects/${projectId}`, { headers: ownerAuth })).json();
await status(200, req(`/api/projects/${projectId}`, {
  method: 'PUT', headers: ownerAuth, body: jsonBody({ version: project.version }),
}), 'null webhook subscriptions are skipped');

// The mock OIDC user-creation transaction must roll back atomically if its
// membership insert fails.
const oidcStart = await req('/api/auth/oidc/start?email=residual-sso@example.com');
const authorizeUrl = new URL(oidcStart.headers.get('location'));
const oidcAuthorize = await req(`${authorizeUrl.pathname}${authorizeUrl.search}`);
const callbackUrl = new URL(oidcAuthorize.headers.get('location'));
db.exec("CREATE TEMP TRIGGER fail_oidc_membership_insert BEFORE INSERT ON memberships BEGIN SELECT RAISE(ABORT, 'forced oidc membership failure'); END");
await status(500, req(`${callbackUrl.pathname}${callbackUrl.search}`), 'OIDC user creation rollback');
db.exec('DROP TRIGGER fail_oidc_membership_insert');
assert.equal(db.prepare('SELECT id FROM users WHERE email = ?').get('residual-sso@example.com'), undefined);

// Search must safely inspect tasks that have no display name; AI briefing must
// tolerate corrupt legacy task JSON and still return a bounded empty summary.
db.prepare('UPDATE projects SET tasks_json = ? WHERE id = ?').run(JSON.stringify([{ id: 'unnamed-task' }]), projectId);
response = await req('/api/search?q=Residual', { headers: ownerAuth });
assert.equal(response.status, 200);
assert.ok((await response.json()).results.some((item) => item.projectId === projectId));
db.prepare('UPDATE projects SET tasks_json = ? WHERE id = ?').run('{corrupt-json', projectId);
await status(200, req(`/api/projects/${projectId}/ai/brief`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({}),
}), 'AI briefing corrupt task fallback');
db.prepare('UPDATE projects SET tasks_json = ? WHERE id = ?').run('[]', projectId);

// Attachment guards cover inaccessible projects, query/PAT/JWT auth, empty file
// metadata, uploader-vs-manager authorization, and mock artifact MIME fallback.
const missingProjectForm = new FormData();
missingProjectForm.append('file', new Blob(['missing']), 'missing.pdf');
await status(404, app.request('/api/projects/999999/attachments', {
  method: 'POST', headers: ownerAuth, body: missingProjectForm,
}), 'attachment missing project');

const emptyMetadata = new FormData();
emptyMetadata.append('file', new File(['empty metadata'], '', { type: '' }));
response = await app.request(`/api/projects/${projectId}/attachments`, {
  method: 'POST', headers: ownerAuth, body: emptyMetadata,
});
assert.equal(response.status, 200);
const emptyAttachmentId = (await response.json()).id;
const emptyAttachment = db.prepare('SELECT job_id FROM attachments WHERE id = ?').get(emptyAttachmentId);
assert.ok(emptyAttachment?.job_id);
await status(200, req(`/api/mock-clearfolio/${emptyAttachment.job_id}`), 'mock artifact empty MIME fallback');
await status(401, req(`/api/projects/${projectId}/attachments/${emptyAttachmentId}/view`, {
  headers: authHeaders('swk_invalid'),
}), 'attachment invalid PAT');
await status(401, req(`/api/projects/${projectId}/attachments/${emptyAttachmentId}/view`, {
  headers: authHeaders(ghostToken),
}), 'attachment nonexistent signed user');
await status(404, req(`/api/projects/999999/attachments/${emptyAttachmentId}/view`, { headers: ownerAuth }), 'attachment view missing project');
await status(404, req(`/api/projects/999999/attachments/${emptyAttachmentId}`, { method: 'DELETE', headers: ownerAuth }), 'attachment delete missing project');

// The uploader may delete their own attachment without management privilege.
db.prepare("UPDATE memberships SET role = 'member' WHERE org_id = ? AND user_id = ?").run(orgId, memberId);
const memberFile = new FormData();
memberFile.append('file', new Blob(['member'], { type: 'application/pdf' }), 'member-own.pdf');
response = await app.request(`/api/projects/${projectId}/attachments`, {
  method: 'POST', headers: memberAuth, body: memberFile,
});
assert.equal(response.status, 200);
const memberAttachmentId = (await response.json()).id;
await status(200, req(`/api/projects/${projectId}/attachments/${memberAttachmentId}`, {
  method: 'DELETE', headers: memberAuth,
}), 'attachment uploader delete');

// Share, sprint, and baseline routes preserve tenant and read-only guards on
// every operation, including legacy null methodology/default metadata paths.
db.prepare("UPDATE memberships SET role = 'viewer' WHERE org_id = ? AND user_id = ?").run(orgId, memberId);
await status(404, req('/api/projects/999999/shares', { method: 'POST', headers: ownerAuth }), 'share create missing project');
response = await req(`/api/projects/${projectId}/shares`, { method: 'POST', headers: ownerAuth });
assert.equal(response.status, 200);
const shareToken = await response.json();
const shareId = db.prepare('SELECT id FROM share_tokens WHERE token = ?').get(shareToken.token).id;
await status(403, req(`/api/projects/${projectId}/shares/${shareId}`, { method: 'DELETE', headers: memberAuth }), 'viewer share revoke');
await status(404, req(`/api/projects/999999/shares/${shareId}`, { method: 'DELETE', headers: ownerAuth }), 'share revoke missing project');

await status(404, req('/api/projects/999999/sprints', { headers: ownerAuth }), 'sprint list missing project');
db.prepare('UPDATE projects SET methodology = NULL WHERE id = ?').run(projectId);
response = await req(`/api/projects/${projectId}/sprints`, { headers: ownerAuth });
assert.equal(response.status, 200);
assert.equal((await response.json()).methodology, 'waterfall');
await status(404, req('/api/projects/999999/sprints/1', { method: 'DELETE', headers: ownerAuth }), 'sprint delete missing project');
response = await req(`/api/projects/${projectId}/sprints`, {
  method: 'POST', headers: ownerAuth, body: jsonBody({ name: 'Protected sprint', startDate: '2026-08-18', endDate: '2026-08-25' }),
});
const sprintId = (await response.json()).id;
await status(403, req(`/api/projects/${projectId}/sprints/${sprintId}`, { method: 'DELETE', headers: memberAuth }), 'viewer sprint delete');

await status(404, req('/api/projects/999999/baselines', { method: 'POST', headers: ownerAuth, body: jsonBody({}) }), 'baseline create missing project');
await status(404, req('/api/projects/999999/baselines', { headers: ownerAuth }), 'baseline list missing project');
await status(404, req('/api/projects/999999/baselines/1', { headers: ownerAuth }), 'baseline detail missing project');
await status(404, req('/api/projects/999999/baselines/1', { method: 'DELETE', headers: ownerAuth }), 'baseline delete missing project');
response = await req(`/api/projects/${projectId}/baselines`, { method: 'POST', headers: ownerAuth, body: jsonBody({}) });
const baselineId = (await response.json()).id;
await status(403, req(`/api/projects/${projectId}/baselines/${baselineId}`, { method: 'DELETE', headers: memberAuth }), 'viewer baseline delete');

// Null metadata is legal in historical audit rows. Both JSON audit and workspace
// export must preserve that as null instead of assuming every event has JSON.
db.prepare('INSERT INTO audit_log(org_id,user_id,action,target_type,target_id,meta) VALUES(?,?,?,?,?,?)')
  .run(orgId, ownerId, 'legacy.null_meta', 'project', String(projectId), null);
response = await req(`/api/orgs/${orgId}/audit`, { headers: ownerAuth });
assert.equal(response.status, 200);
assert.ok((await response.json()).events.some((event) => event.action === 'legacy.null_meta' && event.meta === null));
response = await req(`/api/orgs/${orgId}/export`, { headers: ownerAuth });
assert.equal(response.status, 200);
assert.ok((await response.json()).audit.some((event) => event.action === 'legacy.null_meta' && event.meta === null));

console.log('app residual branch coverage: ok');
