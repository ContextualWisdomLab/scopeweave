import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');
const { signToken } = await import('../../server/auth.mjs');

const json = (value) => JSON.stringify(value);
const request = (path, options = {}) => app.request(path, {
  ...options,
  headers: {
    'content-type': 'application/json',
    ...(options.headers || {}),
  },
});

async function signup(email, name) {
  const response = await request('/api/auth/signup', {
    method: 'POST',
    body: json({ email, name, password: 'password123' }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

const ownerToken = await signup('schedule-owner@example.com', 'Schedule Owner');
const ownerAuth = { authorization: `Bearer ${ownerToken}` };
let response = await request('/api/me', { headers: ownerAuth });
const ownerMe = await response.json();
const ownerId = ownerMe.user.id;
const organizationId = ownerMe.orgs[0].id;

response = await request('/api/projects', {
  method: 'POST',
  headers: ownerAuth,
  body: json({ name: 'Auditable Schedule' }),
});
assert.equal(response.status, 200);
const project = await response.json();

const originalTasks = [{ id: 'task-1', name: 'External dependency' }];
response = await request(`/api/projects/${project.id}`, {
  method: 'PUT',
  headers: ownerAuth,
  body: json({ tasks: originalTasks, version: 1 }),
});
assert.equal(response.status, 200);
assert.equal((await response.json()).version, 2);

const route = `/api/projects/${project.id}/schedule/reasons`;
const occurredAt = '2026-08-24T02:00:00.000Z';
const skippedPayload = {
  workItemId: 'task-1',
  type: 'skipped',
  reasonCode: 'supplier_hold',
  occurredAt,
  version: 2,
  actorId: 'forged-browser-actor',
};

response = await request(route, { method: 'POST', body: json(skippedPayload) });
assert.equal(response.status, 401, 'reason mutation requires authentication');

response = await request(route, {
  method: 'POST',
  headers: { authorization: 'Bearer swk_missing_schedule_reason_token' },
  body: json(skippedPayload),
});
assert.equal(response.status, 401, 'unknown PATs fail before tenant lookup');

const missingUserToken = signToken({
  sub: Number.MAX_SAFE_INTEGER,
  email: 'missing-schedule-user@example.com',
  tv: 0,
});
response = await request(route, {
  method: 'POST',
  headers: { authorization: `Bearer ${missingUserToken}` },
  body: json(skippedPayload),
});
assert.equal(response.status, 401, 'validly signed JWTs still require a live user');

const outsiderToken = await signup('schedule-outsider@example.com', 'Outsider');
response = await request(route, {
  method: 'POST',
  headers: { authorization: `Bearer ${outsiderToken}` },
  body: json(skippedPayload),
});
assert.equal(response.status, 404, 'cross-tenant mutation hides project existence');

const viewerToken = await signup('schedule-viewer@example.com', 'Viewer');
const viewerAuth = { authorization: `Bearer ${viewerToken}` };
response = await request(`/api/orgs/${organizationId}/invites`, {
  method: 'POST',
  headers: ownerAuth,
  body: json({ email: 'schedule-viewer@example.com', role: 'viewer' }),
});
assert.equal(response.status, 200);
const invite = await response.json();
response = await request(`/api/invites/${invite.token}/accept`, {
  method: 'POST',
  headers: viewerAuth,
});
assert.equal(response.status, 200);
response = await request(route, {
  method: 'POST',
  headers: viewerAuth,
  body: json(skippedPayload),
});
assert.equal(response.status, 403, 'viewer cannot record schedule reason facts');

response = await request(route, {
  method: 'POST',
  headers: ownerAuth,
  body: json(skippedPayload),
});
assert.equal(response.status, 201, 'authorized write records explicit skipped reason');
const skipped = await response.json();
assert.equal(skipped.type, 'skipped');
assert.equal(skipped.workItemId, 'task-1');
assert.equal(skipped.projectVersion, 3);
assert.match(skipped.eventId, /^evt_[a-f0-9]{32}$/u);
assert.match(skipped.auditRecordId, /^audit_[a-f0-9]{32}$/u);
assert.equal(response.headers.get('cache-control'), 'no-store');

response = await request(`/api/projects/${project.id}`, { headers: ownerAuth });
assert.equal(response.status, 200);
const afterSkipped = await response.json();
assert.equal(afterSkipped.version, 3, 'reason event advances authoritative project version');
assert.deepEqual(afterSkipped.tasks, originalTasks, 'reason event leaves task document unchanged');

const durableEvent = db.prepare(`
  SELECT organization_id, project_id, work_item_id, actor_id, reason_event_type,
         reason_code, prior_resource_version, committed_resource_version
    FROM schedule_reason_events
   WHERE event_id = ?
`).get(skipped.eventId);
assert.deepEqual({ ...durableEvent }, {
  organization_id: String(organizationId),
  project_id: String(project.id),
  work_item_id: 'task-1',
  actor_id: String(ownerId),
  reason_event_type: 'skipped',
  reason_code: 'supplier_hold',
  prior_resource_version: 'project_version:2',
  committed_resource_version: 'project_version:3',
}, 'durable event derives actor and tenant authority from the authenticated server context');

response = await request(route, {
  method: 'POST',
  headers: ownerAuth,
  body: json({ ...skippedPayload, reasonCode: 'second_attempt' }),
});
assert.equal(response.status, 409, 'stale client project version is rejected');
assert.deepEqual(await response.json(), {
  error: 'Project version changed. Refresh the plan before recording this reason.',
  code: 'schedule_reason_version_conflict',
  action: 'Refresh the project and retry against the current version.',
});
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_events').get().count, 1);

response = await request(route, {
  method: 'POST',
  headers: ownerAuth,
  body: json({
    ...skippedPayload,
    type: 'cancelled',
    reasonCode: 'customer_cancelled',
    version: 3,
    approvalRef: 'browser-selected-approval',
  }),
});
assert.equal(response.status, 409, 'cancellation never trusts browser-selected approval evidence');
assert.deepEqual(await response.json(), {
  error: 'Cancellation requires durable approval from a different authorized user.',
  code: 'schedule_reason_cancellation_approval_required',
  action: 'Ask an owner or admin other than the acting user to record approval, then retry.',
});

response = await request(route, {
  method: 'POST',
  headers: ownerAuth,
  body: json({
    workItemId: 'task-1',
    type: 'not_performed',
    reasonCode: 'scope_removed',
    occurredAt,
    version: 3,
  }),
});
assert.equal(response.status, 201, 'not-performed reasons use the same audited write boundary');
const notPerformed = await response.json();
assert.equal(notPerformed.projectVersion, 4);
assert.equal(notPerformed.type, 'not_performed');

response = await request('/api/tokens', {
  method: 'POST',
  headers: ownerAuth,
  body: json({ name: 'schedule-reason-route' }),
});
assert.equal(response.status, 200);
const ownerPat = await response.json();
response = await request(route, {
  method: 'POST',
  headers: { authorization: `Bearer ${ownerPat.token}` },
  body: json({
    workItemId: 'task-1',
    type: 'skipped',
    reasonCode: 'pat_authorized',
    occurredAt,
    version: 4,
  }),
});
assert.equal(response.status, 201, 'live PATs use the same audited schedule-reason boundary');
const patWrite = await response.json();
assert.equal(patWrite.projectVersion, 5);
assert.equal(patWrite.type, 'skipped');

const staleToken = await signup('schedule-stale-session@example.com', 'Stale Session');
response = await request('/api/auth/logout-all', {
  method: 'POST',
  headers: { authorization: `Bearer ${staleToken}` },
});
assert.equal(response.status, 200);
response = await request(route, {
  method: 'POST',
  headers: { authorization: `Bearer ${staleToken}` },
  body: json({
    workItemId: 'task-1',
    type: 'skipped',
    reasonCode: 'stale_jwt',
    occurredAt,
    version: 5,
  }),
});
assert.equal(response.status, 401, 'JWT token_version revocation is enforced at route entry');

response = await request(route, {
  method: 'POST',
  headers: ownerAuth,
  body: json({
    workItemId: 'task-1',
    type: 'invented',
    reasonCode: 'bad',
    occurredAt,
    version: 5,
  }),
});
assert.equal(response.status, 400, 'unsupported reason types fail closed');
assert.deepEqual(await response.json(), {
  error: 'Schedule reason request is invalid.',
  code: 'schedule_reason_invalid_request',
  action: 'Use skipped or not_performed with the current project version and a valid work item.',
});

const largeBody = json({
  workItemId: 'task-1',
  type: 'skipped',
  reasonCode: 'x'.repeat(5000),
  occurredAt,
  version: 5,
});
response = await request(route, {
  method: 'POST',
  headers: ownerAuth,
  body: largeBody,
});
assert.equal(response.status, 413, 'reason request body is bounded before JSON parsing');
assert.deepEqual(await response.json(), {
  error: 'Schedule reason request is too large.',
  code: 'schedule_reason_request_too_large',
  action: 'Send only the work item, reason, occurrence time, and current project version.',
});

assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_events').get().count, 3);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_event_audit_records').get().count, 3);
console.log('schedule reason API route regression passed');
