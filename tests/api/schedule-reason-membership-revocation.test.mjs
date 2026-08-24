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
const memberMe = await response.json();
const memberId = memberMe.user.id;
const memberHomeOrganizationId = memberMe.orgs[0].id;
db.prepare('INSERT INTO memberships(org_id, user_id, role) VALUES(?,?,?)')
  .run(organizationId, memberId, 'member');

const route = `/api/projects/${project.id}/schedule/reasons`;

async function writeWhileBodyMutation(reasonCode, mutateAuthority) {
  const payload = json({
    workItemId: 'task-1',
    type: 'skipped',
    reasonCode,
    occurredAt: '2026-08-24T02:00:00.000Z',
    version: 2,
  });
  const encodedPayload = new TextEncoder().encode(payload);
  let mutationApplied = false;
  const delayedBody = new ReadableStream({
    pull(controller) {
      mutateAuthority();
      mutationApplied = true;
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
  const result = await app.fetch(revocationRequest);
  assert.equal(mutationApplied, true, 'authority changes only when request body consumption begins');
  return result;
}

response = await writeWhileBodyMutation('membership_removed', () => {
  const deletion = db.prepare('DELETE FROM memberships WHERE org_id = ? AND user_id = ?')
    .run(organizationId, memberId);
  assert.equal(Number(deletion.changes), 1, 'test revokes the writer membership exactly once');
});
assert.equal(
  response.status,
  403,
  'commit-time authority revalidation rejects membership removed after routing begins',
);

db.prepare('INSERT INTO memberships(org_id, user_id, role) VALUES(?,?,?)')
  .run(organizationId, memberId, 'member');
response = await writeWhileBodyMutation('membership_downgraded', () => {
  const downgrade = db.prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?')
    .run('viewer', organizationId, memberId);
  assert.equal(Number(downgrade.changes), 1, 'test downgrades the writer membership exactly once');
});
assert.equal(
  response.status,
  403,
  'commit-time authority revalidation rejects a writer role downgraded after routing begins',
);

db.prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?')
  .run('member', organizationId, memberId);
response = await writeWhileBodyMutation('project_tenant_changed', () => {
  const transfer = db.prepare('UPDATE projects SET org_id = ? WHERE id = ?')
    .run(memberHomeOrganizationId, project.id);
  assert.equal(Number(transfer.changes), 1, 'test changes the project tenant exactly once');
});
assert.equal(
  response.status,
  403,
  'commit-time authority revalidation rejects a project tenant changed after routing begins',
);

assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM schedule_reason_events').get().count,
  0,
  'authority changes cannot persist a reason event',
);
assert.equal(
  db.prepare('SELECT version FROM projects WHERE id = ?').get(project.id).version,
  2,
  'authority changes cannot advance the authoritative project version',
);

console.log('schedule reason membership revocation regression passed');
