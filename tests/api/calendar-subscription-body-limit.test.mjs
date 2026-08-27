import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/runtime_app.mjs');
const { db } = await import('../../server/db.mjs');

const encoder = new TextEncoder();
const json = (value) => JSON.stringify(value);

async function authenticatedProject() {
  let response = await app.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json({
      email: 'calendar-body-limit@example.com',
      password: 'password123',
      name: 'Calendar Body Limit',
    }),
  });
  assert.equal(response.status, 200);
  const token = (await response.json()).token;
  const authorization = `Bearer ${token}`;

  response = await app.request('/api/projects', {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
    },
    body: json({ name: 'Calendar Body Limit Project' }),
  });
  assert.equal(response.status, 200);
  const project = await response.json();
  return { authorization, projectId: project.id };
}

const { authorization, projectId } = await authenticatedProject();
const createPath = `/api/projects/${projectId}/calendar-subscriptions`;
const expiresAtMs = Date.now() + (7 * 24 * 60 * 60 * 1000);
const oversizedCreateBody = json({
  name: 'x'.repeat(5 * 1024),
  expiresAtMs,
});

let response = await app.request(createPath, {
  method: 'POST',
  headers: {
    authorization,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(oversizedCreateBody)),
  },
  body: oversizedCreateBody,
});
assert.equal(response.status, 413, 'declared oversized create bodies fail before JSON buffering');
assert.deepEqual(await response.json(), { error: 'calendar_subscription_body_too_large' });
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM calendar_subscriptions').get().count,
  0,
  'rejected oversized create bodies cannot persist a subscription',
);

response = await app.request(createPath, {
  method: 'POST',
  headers: {
    authorization,
    'content-type': 'application/json',
  },
  body: json({ name: 'Bounded calendar', expiresAtMs }),
});
assert.equal(response.status, 201);
const created = await response.json();

const oversizedRotateBody = json({
  expiresAtMs: Date.now() + (14 * 24 * 60 * 60 * 1000),
  padding: 'y'.repeat(5 * 1024),
});
let sent = false;
const streamedBody = new ReadableStream({
  pull(controller) {
    if (sent) {
      controller.close();
      return;
    }
    sent = true;
    controller.enqueue(encoder.encode(oversizedRotateBody));
  },
});

response = await app.request(
  `/api/projects/${projectId}/calendar-subscriptions/${created.subscriptionId}/rotate`,
  {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
    },
    body: streamedBody,
    duplex: 'half',
  },
);
assert.equal(response.status, 413, 'streamed oversized rotate bodies fail before JSON buffering');
assert.deepEqual(await response.json(), { error: 'calendar_subscription_body_too_large' });
assert.equal(response.headers.get('cache-control'), 'no-store');

const persisted = db.prepare(`
  SELECT expires_at_ms
    FROM calendar_subscriptions
   WHERE subscription_id = ?
`).get(created.subscriptionId);
assert.equal(
  persisted.expires_at_ms,
  created.expiresAtMs,
  'rejected oversized rotate bodies cannot mutate subscription expiry',
);
