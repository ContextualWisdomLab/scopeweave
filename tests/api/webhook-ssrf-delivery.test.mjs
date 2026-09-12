import assert from 'node:assert/strict';
import http from 'node:http';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');
const { db, rowid } = await import('../../server/db.mjs');

const req = (path, opts = {}) =>
  app.request(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
const body = (value) => JSON.stringify(value);

let loopbackHits = 0;
const sink = http.createServer((_request, response) => {
  loopbackHits += 1;
  response.writeHead(204);
  response.end();
});
await new Promise((resolve, reject) => {
  sink.once('error', reject);
  sink.listen(0, '127.0.0.1', resolve);
});

try {
  const address = sink.address();
  assert.ok(address && typeof address === 'object');

  let response = await req('/api/auth/signup', {
    method: 'POST',
    body: body({ email: 'ssrf-boundary@example.com', password: 'password123', name: 'SSRF boundary' }),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  const auth = { authorization: `Bearer ${token}` };

  response = await req('/api/me', { headers: auth });
  assert.equal(response.status, 200);
  const me = await response.json();
  const orgId = me.orgs[0].id;

  response = await req('/api/projects', {
    method: 'POST',
    headers: auth,
    body: body({ name: 'SSRF delivery boundary' }),
  });
  assert.equal(response.status, 200);
  const project = await response.json();

  // Registration now rejects loopback URLs, but persisted rows can pre-date that
  // validation or arrive through a migration. Delivery itself must therefore be
  // the final outbound SSRF boundary rather than trusting stored data forever.
  const webhookId = rowid(db.prepare(
    'INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)',
  ).run(
    orgId,
    `http://127.0.0.1:${address.port}/capture`,
    'whsec_test_delivery_boundary',
    'project.update',
  ));

  response = await req(`/api/projects/${project.id}`, {
    method: 'PUT',
    headers: auth,
    body: body({ tasks: [{ id: '1', name: 'trigger webhook' }], version: project.version }),
  });
  assert.equal(response.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 900));

  assert.equal(
    loopbackHits,
    0,
    'delivery-time SSRF boundary must not connect to a persisted loopback webhook',
  );

  const attempts = db.prepare(
    'SELECT ok, attempt FROM webhook_deliveries WHERE webhook_id = ? ORDER BY attempt',
  ).all(webhookId);
  assert.ok(attempts.length >= 2, 'blocked delivery is recorded and follows bounded retry policy');
  assert.ok(attempts.every((attempt) => attempt.ok === 0), 'blocked delivery attempts are recorded as failures');
  assert.ok(attempts.some((attempt) => attempt.attempt === 2), 'blocked delivery retries once');
} finally {
  await new Promise((resolve) => sink.close(resolve));
}

console.log('webhook delivery SSRF boundary: ok');
