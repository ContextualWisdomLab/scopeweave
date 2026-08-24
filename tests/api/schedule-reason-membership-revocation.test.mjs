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

const ownerToken = await signup('schedule-revocation-owner@example.com', 'Revocation Owner');
const ownerAuth = { authorization: `Bearer ${ownerToken}` };
let response = await request('/api/me', { headers: ownerAuth });
const ownerMe = await response.json();
const organizationId = ownerMe.orgs[0].id;

response = await request('/api/projects', {
  method: 'POST',
  headers: ownerAuth,
  body: json({ name: 'Revocation Boundary' }),
});
assert.equal(response.status, 200);
const project = await response.json();

response = await request(`/api/projects/${project.id}`, {
  method: 'PUT',
  headers: ownerAuth,
  body: json({ tasks: [{ id: 'task-1', name: 'Revocable write' }], version: 1 }),
});
assert.equal(response.status, 200);
assert.equal((await response.json()).version, 2);

const memberToken = await signup('schedule-revocation-member@example.com', 'Revocable Member');
const memberAuth = { authorization: `Bearer ${memberToken}` };
response = await request('/api/me', { headers: memberAuth });
assert.equal(response.status, 200);
const memberId = (await response.json()).user.id;
db.prepare('INSERT INTO memberships(org_id, user_id, role) VALUES(?,?,?)')
  .run(organizationId, memberId, 'member');

const route = `/api/projects/${project.id}/schedule/reasons`;
const payload = json({
  workItemId: 'task-1',
  type: 'skipped',
  reasonCode: 'revoked_while_reading',
  occurredAt: '2026-08-24T02:00:00.000Z',
  version: 2,
});
const encodedPayload = new TextEncoder().encode(payload);
let revokedDuringBodyRead = false;
const delayedBody = new ReadableStream({
  pull(controller) {
    const deletion = db.prepare('DELETE FROM memberships WHERE org_id = ? AND user_id = ?')
      .run(organizationId, memberId);
    assert.equal(Number(deletion.changes), 1, 'test revokes the writer membership exactly once');
    revokedDuringBodyRead = true;
    controller.enqueue(encodedPayload);
    controller.close();
  },
});

const revocationRequest = new Request(`http://localhost${route}`, {
  method: 'POST',
  headers: {
    ...memberAuth,
    'content-type': 'application/json',
    'content-length': String(encodedPayload.byteLength),
  },
  body: delayedBody,
  duplex: 'half',
});
response = await app.fetch(revocationRequest);
assert.equal(revokedDuringBodyRead, true, 'membership is revoked only when request body consumption begins');
assert.equal(
  response.status,
  404,
  'a membership revoked after routing begins cannot retain stale tenant write authority',
);
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_events').get().count,
  0,
  'revoked membership cannot persist a reason event',
);
assert.equal(
  db.prepare('SELECT version FROM projects WHERE id = ?').get(project.id).version,
  2,
  'revoked membership cannot advance the authoritative project version',
);

console.log('schedule reason membership revocation regression passed');
