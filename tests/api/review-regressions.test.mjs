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

function prometheusMetric(text, name) {
  const match = text.match(new RegExp(`^${name}\\s+(-?\\d+(?:\\.\\d+)?)$`, 'm'));
  assert.ok(match, `Prometheus output includes ${name}`);
  return Number(match[1]);
}

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

test('invalid webhook credentials cannot force unbounded pre-auth body buffering', async () => {
  let bodyPulls = 0;
  const chunk = new Uint8Array(8 * 1024).fill(0x20);
  const requestBody = new ReadableStream({
    pull(controller) {
      bodyPulls += 1;
      if (bodyPulls > 20) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const invalidCredentialRequest = new Request(
    'http://localhost/api/orgs/not-authorized/webhooks',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer definitely-not-a-valid-session',
        'content-type': 'application/json',
      },
      body: requestBody,
      duplex: 'half',
    },
  );

  const response = await app.request(invalidCredentialRequest);
  assert.equal(response.status, 401, 'invalid credentials remain unauthorized');
  assert.ok(
    bodyPulls <= 3,
    `pre-auth webhook parsing must stop at the bounded request budget; observed ${bodyPulls} pulls`,
  );
});

test('public auth rejects an oversized streaming body before unbounded buffering', async () => {
  let bodyPulls = 0;
  const chunk = new Uint8Array(8 * 1024).fill(0x20);
  const requestBody = new ReadableStream({
    pull(controller) {
      bodyPulls += 1;
      if (bodyPulls > 20) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const oversizedLogin = new Request(
    'http://localhost/api/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
      duplex: 'half',
    },
  );

  const response = await app.request(oversizedLogin);
  assert.equal(
    response.status,
    413,
    'public login rejects a body that exceeds the bounded authentication budget',
  );
  assert.deepEqual(
    await response.json(),
    { error: 'authentication request body too large' },
    'oversized public authentication uses a stable non-secret rejection contract',
  );
  assert.ok(
    bodyPulls <= 3,
    `authentication parsing must stop at the bounded request budget; observed ${bodyPulls} pulls`,
  );
});

test('actual webhook deliveries stay behind the SSRF destination policy without replacing global fetch', async () => {
  const { token, org } = await createOwner('webhook-delivery-boundary@scopeweave.test');
  const created = await request('/api/projects', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: body({ name: 'Webhook Boundary', orgId: org.id }),
  });
  assert.equal(created.status, 200, 'project creation succeeds');
  const project = await created.json();

  const inserted = db.prepare(
    'INSERT INTO webhooks(org_id,url,secret,events) VALUES(?,?,?,?)',
  ).run(org.id, 'https://127.0.0.1/internal', 'whsec_review_regression', 'project.update');
  const webhookId = Number(inserted.lastInsertRowid);
  const forwardedBefore = forwardedFetches.length;

  const updated = await request(`/api/projects/${project.id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: body({ name: 'Webhook Boundary', version: 1, tasks: [] }),
  });
  assert.equal(updated.status, 200, 'customer save succeeds while webhook delivery is isolated');

  const deliveryQuery = db.prepare(
    'SELECT status_code AS statusCode, ok, attempt FROM webhook_deliveries WHERE webhook_id = ? ORDER BY attempt',
  );
  let deliveries = [];
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    deliveries = deliveryQuery.all(webhookId);
    if (deliveries.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.deepEqual(
    deliveries.map(({ statusCode, ok, attempt }) => ({ statusCode, ok, attempt })),
    [
      { statusCode: null, ok: 0, attempt: 1 },
      { statusCode: null, ok: 0, attempt: 2 },
    ],
    'private webhook destinations fail closed on both bounded attempts',
  );
  assert.equal(
    forwardedFetches.length,
    forwardedBefore,
    'webhook delivery never reaches the caller-owned process fetch implementation',
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

test('facade webhook rejection is observed as the real POST exactly once', async () => {
  const { token, org } = await createOwner('facade-observability@scopeweave.test');
  const before = await (await request('/api/metrics')).json();

  const rejected = await request(`/api/orgs/${org.id}/webhooks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: body({ url: 'http://127.0.0.1/private', events: ['project.update'] }),
  });
  assert.equal(rejected.status, 400, 'authorized private destination is rejected by the facade');

  const after = await (await request('/api/metrics')).json();
  assert.equal(
    after.requests,
    before.requests + 2,
    'metrics include the baseline metrics GET and one customer-visible rejected POST, not an internal probe',
  );
  assert.equal(
    after.s2xx,
    before.s2xx + 1,
    'the internal authorization probe is not counted as a successful customer request',
  );
  assert.equal(
    after.s4xx,
    before.s4xx + 1,
    'the facade-generated 400 is counted as the customer-visible request outcome',
  );
});

test('oversized webhook authorization probe is not observed as a synthetic core request', async () => {
  const { token, org } = await createOwner('oversized-webhook-observability@scopeweave.test');
  const coreBefore = await (await coreApp.request('/api/metrics')).json();

  const rejected = await request(`/api/orgs/${org.id}/webhooks`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-length': String(17 * 1024),
    },
    body: body({ url: 'https://hooks.example.test', events: ['project.update'] }),
  });
  assert.equal(rejected.status, 413, 'authorized oversized registration is rejected by the facade');

  const coreAfter = await (await coreApp.request('/api/metrics')).json();
  assert.equal(
    coreAfter.requests,
    coreBefore.requests + 1,
    'the authorization probe must not appear as a second customer request in core metrics',
  );
  assert.equal(
    coreAfter.s2xx,
    coreBefore.s2xx + 1,
    'only the baseline core metrics request is observed between snapshots',
  );
  assert.equal(
    coreAfter.s4xx,
    coreBefore.s4xx,
    'the probe 400 must not be recorded in place of the customer-visible 413',
  );

  const combined = await (await request('/api/metrics')).json();
  assert.ok(
    combined.s4xx >= coreAfter.s4xx + 1,
    'the customer-visible facade rejection remains represented in combined metrics',
  );
});

test('facade OIDC rejection is observed as the real request exactly once', async () => {
  const before = await (await request('/api/metrics')).json();

  const rejected = await request('/api/auth/oidc/start');
  assert.equal(rejected.status, 404, 'unconfigured production OIDC remains hidden as not found');

  const after = await (await request('/api/metrics')).json();
  assert.equal(
    after.requests,
    before.requests + 2,
    'metrics include the baseline metrics GET and one facade-rejected OIDC request',
  );
  assert.equal(
    after.s2xx,
    before.s2xx + 1,
    'only the follow-up metrics request increments the success class',
  );
  assert.equal(
    after.s4xx,
    before.s4xx + 1,
    'the facade-generated OIDC 404 is counted as the customer-visible outcome',
  );
});

test('Prometheus metrics include facade-only request outcomes', async () => {
  const beforeText = await (await request('/api/metrics?format=prometheus')).text();
  const before = {
    requests: prometheusMetric(beforeText, 'scopeweave_requests'),
    s2xx: prometheusMetric(beforeText, 'scopeweave_s2xx'),
    s4xx: prometheusMetric(beforeText, 'scopeweave_s4xx'),
  };

  const rejected = await request('/api/auth/oidc/start');
  assert.equal(rejected.status, 404, 'facade-only OIDC rejection is reproduced');

  const afterText = await (await request('/api/metrics?format=prometheus')).text();
  const after = {
    requests: prometheusMetric(afterText, 'scopeweave_requests'),
    s2xx: prometheusMetric(afterText, 'scopeweave_s2xx'),
    s4xx: prometheusMetric(afterText, 'scopeweave_s4xx'),
  };
  assert.equal(
    after.requests,
    before.requests + 2,
    'Prometheus request totals include the baseline scrape and the facade-only rejection',
  );
  assert.equal(
    after.s2xx,
    before.s2xx + 1,
    'Prometheus success totals include only the baseline scrape',
  );
  assert.equal(
    after.s4xx,
    before.s4xx + 1,
    'Prometheus client-error totals include the facade-only rejection',
  );
});
