import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');
const { app: coreApp } = await import('../../server/app_core.mjs');
const { db } = await import('../../server/db.mjs');

const body = (value) => JSON.stringify(value);
const request = (target, options = {}) => app.request(target, {
  ...options,
  headers: {
    'content-type': 'application/json',
    ...(options.headers || {}),
  },
});

async function createOwner(email) {
  const response = await request('/api/auth/signup', {
    method: 'POST',
    body: body({ email, password: 'password123', name: 'Review Regression' }),
  });
  assert.equal(response.status, 200, `signup succeeds for ${email}`);
  const { token } = await response.json();
  const me = await request('/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.status, 200, 'owner session resolves');
  const payload = await me.json();
  return { token, user: payload.user, org: payload.orgs[0] };
}

test('webhook registration policy is enforced by the core route, not only an outer facade', async () => {
  const { token, org } = await createOwner('core-webhook-policy@scopeweave.test');
  const response = await coreApp.request(`/api/orgs/${org.id}/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body({ url: 'http://127.0.0.1:8080/internal', events: ['project.updated'] }),
  });
  assert.equal(response.status, 400, 'core registration rejects an SSRF-capable loopback target');
  assert.deepEqual(await response.json(), { error: 'valid public https webhook URL required' });
});

test('signup and login use one canonical email identity', async () => {
  const response = await request('/api/auth/signup', {
    method: 'POST',
    body: body({
      email: '  Mixed.Case@ScopeWeave.Test  ',
      password: 'password123',
      name: 'Mixed Case',
    }),
  });
  assert.equal(response.status, 200, 'mixed-case signup succeeds');
  const { token } = await response.json();

  const me = await request('/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, 'mixed.case@scopeweave.test');

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: body({ email: 'MIXED.CASE@SCOPEWEAVE.TEST', password: 'password123' }),
  });
  assert.equal(login.status, 200, 'case-insensitive canonical login succeeds');

  const duplicate = await request('/api/auth/signup', {
    method: 'POST',
    body: body({
      email: 'mixed.case@scopeweave.test',
      password: 'password456',
      name: 'Duplicate',
    }),
  });
  assert.equal(duplicate.status, 409, 'canonical duplicate identity is rejected');
});

test('audit pagination rejects non-positive limits instead of expanding to the full tenant history', async () => {
  const { token, user, org } = await createOwner('audit-limit@scopeweave.test');
  const insert = db.prepare(
    'INSERT INTO audit_log(org_id,user_id,action,target_type,target_id,meta) VALUES(?,?,?,?,?,?)',
  );
  for (let index = 0; index < 125; index += 1) {
    insert.run(org.id, user.id, 'review.regression', 'test_event', String(index), null);
  }

  const response = await request(`/api/orgs/${org.id}/audit?limit=-1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const { events } = await response.json();
  assert.equal(events.length, 100, 'invalid negative limit falls back to the bounded default');
});
