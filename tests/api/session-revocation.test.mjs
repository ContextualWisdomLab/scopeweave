// Security invariant: logout-all revocation must apply uniformly to every
// URL-token endpoint. Calendar clients and EventSource cannot reliably send
// Authorization headers, so these routes accept JWTs in the query string and
// must enforce the same token_version check as requireAuth.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

const req = (path, opts = {}) =>
  app.request(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
const body = (value) => JSON.stringify(value);

async function expectStreamStatus(projectId, token, status, message) {
  const response = await req(
    `/api/projects/${projectId}/stream?token=${encodeURIComponent(token)}`
  );
  assert.equal(response.status, status, message);
  await response.body?.cancel?.();
}

async function expectCalendarStatus(projectId, token, status, message) {
  const response = await req(
    `/api/projects/${projectId}/calendar.ics?token=${encodeURIComponent(token)}`
  );
  assert.equal(response.status, status, message);
}

async function expectAttachmentViewStatus(projectId, token, status, message) {
  const response = await req(
    `/api/projects/${projectId}/attachments/missing/view?token=${encodeURIComponent(token)}`
  );
  assert.equal(response.status, status, message);
}

test('logout-all revokes every URL-transport session JWT across devices', async () => {
  let response = await req('/api/auth/signup', {
    method: 'POST',
    body: body({
      email: 'revocation-test@scopeweave.test',
      password: 'password123',
      name: 'Revocation Test',
    }),
  });
  assert.equal(response.status, 200, 'signup succeeds');
  const tokenA = (await response.json()).token;

  const authA = { authorization: `Bearer ${tokenA}` };
  response = await req('/api/projects', {
    method: 'POST',
    headers: authA,
    body: body({ name: 'Revocation Probe' }),
  });
  assert.equal(response.status, 200, 'project creation succeeds');
  const projectId = (await response.json()).id;

  response = await req('/api/auth/login', {
    method: 'POST',
    body: body({
      email: 'revocation-test@scopeweave.test',
      password: 'password123',
    }),
  });
  assert.equal(response.status, 200, 'second-device login succeeds');
  const tokenB = (await response.json()).token;

  await expectCalendarStatus(projectId, tokenA, 200, 'calendar accepts token A before revocation');
  await expectCalendarStatus(projectId, tokenB, 200, 'calendar accepts token B before revocation');
  await expectStreamStatus(projectId, tokenA, 200, 'SSE accepts token A before revocation');
  await expectStreamStatus(projectId, tokenB, 200, 'SSE accepts token B before revocation');
  await expectAttachmentViewStatus(projectId, tokenA, 404, 'attachment view authenticates token A before lookup');
  await expectAttachmentViewStatus(projectId, tokenB, 404, 'attachment view authenticates token B before lookup');

  response = await req('/api/auth/logout-all', {
    method: 'POST',
    headers: authA,
  });
  assert.equal(response.status, 200, 'logout-all succeeds');
  const freshToken = (await response.json()).token;

  for (const [label, staleToken] of [['A', tokenA], ['B', tokenB]]) {
    await expectCalendarStatus(
      projectId,
      staleToken,
      401,
      `calendar rejects stale token ${label}`
    );
    await expectStreamStatus(
      projectId,
      staleToken,
      401,
      `SSE rejects stale token ${label}`
    );
    await expectAttachmentViewStatus(
      projectId,
      staleToken,
      401,
      `attachment view rejects stale token ${label}`
    );
  }

  await expectCalendarStatus(projectId, freshToken, 200, 'calendar accepts replacement token');
  await expectStreamStatus(projectId, freshToken, 200, 'SSE accepts replacement token');
  await expectAttachmentViewStatus(projectId, freshToken, 404, 'attachment view accepts replacement token before lookup');
});
