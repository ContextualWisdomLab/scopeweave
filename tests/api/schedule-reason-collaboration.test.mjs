import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

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

const ownerToken = await signup('schedule-collaboration-owner@example.com', 'Schedule Collaboration Owner');
const ownerAuth = { authorization: `Bearer ${ownerToken}` };
let response = await request('/api/me', { headers: ownerAuth });
const ownerMe = await response.json();
const ownerId = ownerMe.user.id;
const organizationId = ownerMe.orgs[0].id;

response = await request('/api/projects', {
  method: 'POST',
  headers: ownerAuth,
  body: json({ name: 'Collaborative Schedule' }),
});
assert.equal(response.status, 200);
const project = await response.json();

const tasks = [{ id: 'task-1', name: 'Publish schedule reason' }];
response = await request(`/api/projects/${project.id}`, {
  method: 'PUT',
  headers: ownerAuth,
  body: json({ tasks, version: 1 }),
});
assert.equal(response.status, 200);
assert.equal((await response.json()).version, 2);

db.prepare('INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)')
  .run(organizationId, 'https://webhook.example.invalid/schedule', 'whsec_schedule_collaboration', 'project.update');

const outbound = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  outbound.push({
    url: String(url),
    event: options.headers?.['x-scopeweave-event'],
    body: JSON.parse(String(options.body || '{}')),
  });
  return new Response(null, { status: 204 });
};

const streamAbort = new AbortController();
const streamResponse = await app.request(
  `/api/projects/${project.id}/stream?token=${encodeURIComponent(ownerToken)}`,
  { signal: streamAbort.signal },
);
assert.equal(streamResponse.status, 200);
const streamReader = streamResponse.body.getReader();
const connected = await streamReader.read();
assert.equal(connected.done, false);
assert.match(new TextDecoder().decode(connected.value), /^: connected/u);

response = await request(`/api/projects/${project.id}/schedule/reasons`, {
  method: 'POST',
  headers: ownerAuth,
  body: json({
    workItemId: 'task-1',
    type: 'skipped',
    reasonCode: 'supplier_hold',
    occurredAt: '2026-08-27T01:00:00.000Z',
    version: 2,
  }),
});
assert.equal(response.status, 201);
const reason = await response.json();
assert.equal(reason.projectVersion, 3);

const update = await Promise.race([
  streamReader.read(),
  new Promise((_, reject) => setTimeout(
    () => reject(new Error('schedule reason version change was not broadcast to connected collaborators')),
    250,
  )),
]);
assert.equal(update.done, false);
const eventText = new TextDecoder().decode(update.value);
assert.match(eventText, /^data: /u);
const event = JSON.parse(eventText.replace(/^data: /u, '').trim());
assert.deepEqual(event, { type: 'update', version: 3, by: ownerId });

assert.equal(outbound.length, 1, 'schedule reason version change emits the ordinary project.update webhook');
assert.equal(outbound[0].event, 'project.update');
assert.equal(outbound[0].url, 'https://webhook.example.invalid/schedule');
assert.deepEqual(outbound[0].body.payload, {
  projectId: project.id,
  version: 3,
  tasks: 1,
  by: ownerId,
});

streamAbort.abort();
await streamReader.cancel().catch(() => {});
globalThis.fetch = originalFetch;

console.log('schedule reason collaboration notification regression passed');
