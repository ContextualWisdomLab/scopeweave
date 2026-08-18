import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const forwardedFetches = [];
globalThis.fetch = async (input, init) => {
  const forwarded = new Request(input, init);
  const forwardedBody = forwarded.body ? await forwarded.text() : '';
  forwardedFetches.push({
    url: forwarded.url,
    method: forwarded.method,
    body: forwardedBody,
  });
  return new Response(forwardedBody, { status: 200 });
};

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

test('unauthenticated webhook registration rejects before consuming the request body', async () => {
  let bodyPulls = 0;
  const requestBody = new ReadableStream({
    pull(controller) {
      bodyPulls += 1;
      controller.enqueue(new TextEncoder().encode(body({
        url: 'http://127.0.0.1/private',
        events: ['project.update'],
      })));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const unauthenticated = new Request(
    'http://localhost/api/orgs/not-authorized/webhooks',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
      duplex: 'half',
    },
  );

  const response = await app.request(unauthenticated);
  assert.equal(response.status, 401, 'authentication rejects the request');
  assert.equal(
    bodyPulls,
    0,
    'the webhook payload is not parsed or buffered before authentication succeeds',
  );
});

test('signed webhook Request inputs stay behind the SSRF destination policy', async () => {
  const signedRequest = new Request('https://127.0.0.1/internal', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-scopeweave-event': 'project.update',
      'x-scopeweave-signature': `sha256=${'a'.repeat(64)}`,
    },
    body: body({ event: 'project.update' }),
  });

  await assert.rejects(
    globalThis.fetch(signedRequest),
    (error) => error?.name === 'WebhookDestinationError',
    'Request-object webhook sends must use the same fail-closed transport as URL+init sends',
  );
});

test('non-webhook Request inputs preserve their body through the fetch facade', async () => {
  const upstream = new Request('https://api.example.test/echo', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'request-body-must-survive',
  });

  const response = await globalThis.fetch(upstream);
  assert.equal(response.status, 200, 'the underlying fetch receives a usable Request');
  assert.equal(await response.text(), 'request-body-must-survive');
  assert.deepEqual(
    forwardedFetches.at(-1),
    {
      url: 'https://api.example.test/echo',
      method: 'POST',
      body: 'request-body-must-survive',
    },
    'fallback fetch receives the effective Request instead of the already-consumed original',
  );
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

test('webhook authorization probing never treats an arbitrary 400 as authorization success', async () => {
  const { token, org } = await createOwner('webhook-probe@scopeweave.test');
  const target = `/api/orgs/${org.id}/webhooks`;

  const denied = await request(target, {
    method: 'POST',
    body: body({ url: 'http://127.0.0.1/private', events: ['project.update'] }),
  });
  assert.equal(denied.status, 401, 'destination validation never bypasses authentication');

  const originalCoreFetch = coreApp.fetch;
  let facadeResponse;
  coreApp.fetch = async () => Response.json(
    { error: 'unrelated controlled-probe failure' },
    { status: 400 },
  );
  try {
    facadeResponse = await request(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: body({ url: 'http://127.0.0.1/private', events: ['project.update'] }),
    });
  } finally {
    coreApp.fetch = originalCoreFetch;
  }

  assert.equal(facadeResponse.status, 400);
  assert.deepEqual(
    await facadeResponse.json(),
    { error: 'unrelated controlled-probe failure' },
    'only an explicit successful authorization probe may be replaced by the public destination-policy error',
  );
});
