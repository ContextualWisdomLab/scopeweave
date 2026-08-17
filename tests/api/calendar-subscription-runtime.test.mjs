import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/runtime_app.mjs');

const req = (path, opts = {}) => app.request(path, {
  ...opts,
  headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
});
const json = (value) => JSON.stringify(value);

let response = await req('/api/auth/signup', {
  method: 'POST',
  body: json({ email: 'calendar-owner@example.com', password: 'password123', name: 'Calendar Owner' }),
});
assert.equal(response.status, 200);
const { token } = await response.json();
let currentToken = token;
let auth = { authorization: `Bearer ${currentToken}` };

response = await req('/api/projects', {
  method: 'POST',
  headers: auth,
  body: json({ name: 'Calendar Project' }),
});
assert.equal(response.status, 200);
const project = await response.json();

response = await req(`/api/projects/${project.id}`, {
  method: 'PUT',
  headers: auth,
  body: json({
    version: 1,
    baseDate: '2026-08-01',
    tasks: [
      {
        id: 'calendar-task-1',
        name: 'Ship calendar runtime',
        plannedStartDate: '2026-08-18',
        plannedEndDate: '2026-08-19',
      },
      {
        id: 'calendar-task-2',
        task: 'Fallback task label',
        plannedStartDate: '2026-08-20',
        plannedEndDate: '2026-08-20',
      },
      {
        id: 'calendar-task-3',
        plannedStartDate: 'not-a-date',
        plannedEndDate: '2026-08-21',
      },
    ],
  }),
});
assert.equal(response.status, 200);

const expiresAtMs = Date.now() + (7 * 24 * 60 * 60 * 1000);
response = await req(`/api/projects/${project.id}/calendar-subscriptions`, {
  method: 'POST',
  body: json({ name: 'Unauthenticated', expiresAtMs }),
});
assert.equal(response.status, 401, 'management endpoints require normal authenticated authority');

response = await req(`/api/projects/${project.id}/calendar-subscriptions`, {
  method: 'POST',
  headers: auth,
  body: json({ name: '', expiresAtMs }),
});
assert.equal(response.status, 400, 'domain validation errors retain stable client status');

response = await req(`/api/projects/${project.id}/calendar-subscriptions`, {
  method: 'POST',
  headers: auth,
  body: json({ name: 'Primary calendar', expiresAtMs }),
});
assert.equal(response.status, 201, 'owner can create a calendar subscription');
assert.equal(response.headers.get('cache-control'), 'no-store');
const created = await response.json();
assert.match(created.secret, /^[A-Za-z0-9_-]{43}$/);
assert.match(created.subscriptionId, /^csub_[a-f0-9]{32}$/);
assert.equal(created.projectId, String(project.id));
assert.equal(created.purpose, 'calendar_read');
assert.equal(created.audience, 'scopeweave:calendar');
assert.ok(created.feedPath.includes('subscription='));
assert.ok(!created.feedPath.includes('token='));
assert.ok(created.feedPath.includes(encodeURIComponent(created.secret)));

response = await req(`/api/projects/${project.id}/calendar-subscriptions`, { headers: auth });
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
const listed = await response.json();
assert.equal(listed.subscriptions.length, 1);
assert.equal(listed.subscriptions[0].subscriptionId, created.subscriptionId);
assert.equal(listed.subscriptions[0].status, 'active');
assert.ok(!('secret' in listed.subscriptions[0]));
assert.ok(!('secret_hash' in listed.subscriptions[0]));

response = await req(created.feedPath);
assert.equal(response.status, 200, 'subscription secret authorizes only the calendar feed');
assert.match(response.headers.get('content-type') || '', /^text\/calendar/);
assert.equal(response.headers.get('cache-control'), 'private, no-store');
assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
const feed = await response.text();
assert.match(feed, /BEGIN:VCALENDAR/);
assert.match(feed, /SUMMARY:Ship calendar runtime/);
assert.match(feed, /SUMMARY:Fallback task label/);
assert.doesNotMatch(feed, /calendar-task-3/, 'invalid task dates are omitted from the feed');

response = await req(`${created.feedPath}&token=${encodeURIComponent(currentToken)}`);
assert.equal(response.status, 401, 'mixed subscription and session-query credentials fail closed');
response = await req(created.feedPath, { headers: auth });
assert.equal(response.status, 401, 'mixed subscription and Authorization credentials fail closed');

response = await req('/api/projects', {
  method: 'POST',
  headers: auth,
  body: json({ name: 'Other Project' }),
});
assert.equal(response.status, 200);
const otherProject = await response.json();
response = await req(`/api/projects/${otherProject.id}/calendar.ics?subscription=${encodeURIComponent(created.secret)}`);
assert.equal(response.status, 401, 'subscription cannot cross project boundaries');

response = await req(`/api/projects/${project.id}/calendar-subscriptions/${created.subscriptionId}/rotate`, {
  method: 'POST',
  headers: auth,
  body: json({ expiresAtMs: Date.now() + (14 * 24 * 60 * 60 * 1000) }),
});
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
const rotated = await response.json();
assert.match(rotated.secret, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(rotated.secret, created.secret);

response = await req(created.feedPath);
assert.equal(response.status, 401, 'rotation immediately invalidates the previous secret');
response = await req(`/api/projects/${project.id}/calendar.ics?subscription=${encodeURIComponent(rotated.secret)}`);
assert.equal(response.status, 200, 'rotated secret authorizes the bound calendar feed');

response = await req('/api/auth/logout-all', { method: 'POST', headers: auth });
assert.equal(response.status, 200, 'logout-all advances the session membership epoch');
const logoutPayload = await response.json();
assert.ok(logoutPayload.token, 'logout-all returns a replacement session');
const staleToken = currentToken;
currentToken = logoutPayload.token;
auth = { authorization: `Bearer ${currentToken}` };

response = await req(`/api/projects/${project.id}/calendar.ics?token=${encodeURIComponent(staleToken)}`);
assert.equal(response.status, 401, 'legacy calendar transport rejects the stale general session');
response = await req(`/api/projects/${project.id}/calendar-subscriptions`, {
  headers: { authorization: `Bearer ${staleToken}` },
});
assert.equal(response.status, 401, 'management API rejects the stale general session');
response = await req(`/api/projects/${project.id}/calendar.ics?subscription=${encodeURIComponent(rotated.secret)}`);
assert.equal(response.status, 401, 'subscription issued under the previous session epoch is invalidated');

response = await req(`/api/projects/${project.id}/calendar-subscriptions/${created.subscriptionId}/rotate`, {
  method: 'POST',
  headers: auth,
  body: json({ expiresAtMs: Date.now() + (21 * 24 * 60 * 60 * 1000) }),
});
assert.equal(response.status, 200, 'freshly authorized rotation re-binds the subscription to the live epoch');
const rebound = await response.json();
assert.notEqual(rebound.secret, rotated.secret);
response = await req(`/api/projects/${project.id}/calendar.ics?subscription=${encodeURIComponent(rebound.secret)}`);
assert.equal(response.status, 200, 're-bound subscription works after session epoch advancement');

response = await req(`/api/projects/${project.id}/calendar-subscriptions/${created.subscriptionId}`, {
  method: 'DELETE',
  headers: auth,
});
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
const revoked = await response.json();
assert.equal(revoked.status, 'revoked');
assert.ok(!('secret' in revoked));

response = await req(`/api/projects/${project.id}/calendar.ics?subscription=${encodeURIComponent(rebound.secret)}`);
assert.equal(response.status, 401, 'revocation immediately invalidates the re-bound secret');

response = await req('/api/auth/signup', {
  method: 'POST',
  body: json({ email: 'calendar-outsider@example.com', password: 'password123', name: 'Outsider' }),
});
assert.equal(response.status, 200);
const outsiderToken = (await response.json()).token;
response = await req(`/api/projects/${project.id}/calendar-subscriptions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${outsiderToken}` },
  body: json({ name: 'Probe', expiresAtMs }),
});
assert.equal(response.status, 404, 'management authorization does not disclose cross-tenant project existence');

response = await req(`/api/projects/${project.id}/calendar.ics?token=${encodeURIComponent(currentToken)}`);
assert.equal(response.status, 200, 'legacy session-query calendar transport remains during the staged migration');
response = await req(`/api/projects/${project.id}/calendar.ics?token=${encodeURIComponent(currentToken)}`, { headers: auth });
assert.equal(response.status, 401, 'mixed legacy query and Authorization credentials fail closed');
response = await req(`/api/projects/${otherProject.id}/calendar.ics?token=${encodeURIComponent(currentToken)}`);
assert.equal(response.status, 200, 'current session retains access to another owned project');
response = await req(`/api/projects/999999/calendar.ics?token=${encodeURIComponent(currentToken)}`);
assert.equal(response.status, 404, 'legacy authenticated transport preserves tenant-nondisclosing project lookup');
