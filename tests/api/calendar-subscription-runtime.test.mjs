import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

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
const auth = { authorization: `Bearer ${token}` };

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
    tasks: [{
      id: 'calendar-task-1',
      name: 'Ship calendar runtime',
      plannedStartDate: '2026-08-18',
      plannedEndDate: '2026-08-19',
    }],
  }),
});
assert.equal(response.status, 200);

const expiresAtMs = Date.now() + (7 * 24 * 60 * 60 * 1000);
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
const feed = await response.text();
assert.match(feed, /BEGIN:VCALENDAR/);
assert.match(feed, /SUMMARY:Ship calendar runtime/);

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

response = await req(`/api/projects/${project.id}/calendar-subscriptions/${created.subscriptionId}`, {
  method: 'DELETE',
  headers: auth,
});
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
const revoked = await response.json();
assert.equal(revoked.status, 'revoked');
assert.ok(!('secret' in revoked));

response = await req(`/api/projects/${project.id}/calendar.ics?subscription=${encodeURIComponent(rotated.secret)}`);
assert.equal(response.status, 401, 'revocation immediately invalidates the rotated secret');

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

response = await req(`/api/projects/${project.id}/calendar.ics?token=${encodeURIComponent(token)}`);
assert.equal(response.status, 200, 'legacy session-query calendar transport remains during the staged migration');
