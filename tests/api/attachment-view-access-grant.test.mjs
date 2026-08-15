import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.CLEARFOLIO_URL = '';

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

function jsonRequest(path, { method = 'GET', token, body } = {}) {
  return app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function signup(email) {
  const response = await jsonRequest('/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'password123', name: email.split('@')[0] },
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

async function createProject(token, name) {
  const response = await jsonRequest('/api/projects', {
    method: 'POST',
    token,
    body: { name },
  });
  assert.equal(response.status, 200);
  return (await response.json()).id;
}

async function uploadReadyAttachment(projectId, token, taskId = 'task-a') {
  const form = new FormData();
  form.append(
    'file',
    new Blob(['buyer-visible attachment'], { type: 'text/plain' }),
    'evidence.txt',
  );
  form.set('taskId', taskId);
  const response = await app.request(`/api/projects/${projectId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, 'SUCCEEDED');
  return payload.id;
}

async function mintAttachmentViewGrant(projectId, attachmentId, token) {
  return jsonRequest(`/api/projects/${projectId}/access-grants`, {
    method: 'POST',
    token,
    body: {
      purpose: 'attachment_view',
      attachmentId: String(attachmentId),
    },
  });
}

test('attachment viewing exchanges a session for a one-time resource-bound grant', async () => {
  const ownerToken = await signup('grant-owner@scopeweave.test');
  const projectId = await createProject(ownerToken, 'Grant Migration Project');
  const attachmentId = await uploadReadyAttachment(projectId, ownerToken);

  let response = await mintAttachmentViewGrant(projectId, attachmentId, ownerToken);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const minted = await response.json();
  assert.match(minted.grant, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.purpose, 'attachment_view');
  assert.equal(minted.projectId, String(projectId));
  assert.equal(minted.attachmentId, String(attachmentId));
  assert.ok(Number.isSafeInteger(minted.expiresAtMs));
  assert.equal(JSON.stringify(minted).includes(ownerToken), false, 'exchange never echoes the session JWT');

  response = await app.request(
    `/api/projects/${projectId}/attachments/${attachmentId}/view?token=${encodeURIComponent(ownerToken)}`,
  );
  assert.equal(response.status, 401, 'legacy full-session query transport is rejected after migration');

  response = await app.request(
    `/api/projects/${projectId}/attachments/${Number(attachmentId) + 1}/view?grant=${encodeURIComponent(minted.grant)}`,
  );
  assert.equal(response.status, 401, 'wrong attachment binding fails closed');

  response = await app.request(
    `/api/projects/${projectId}/attachments/${attachmentId}/view?grant=${encodeURIComponent(minted.grant)}`,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  const location = response.headers.get('location') || '';
  assert.ok(location.length > 0);
  assert.equal(location.includes(minted.grant), false, 'downstream redirect never carries the one-time grant');
  assert.equal(location.includes(ownerToken), false, 'downstream redirect never carries the session JWT');

  response = await app.request(
    `/api/projects/${projectId}/attachments/${attachmentId}/view?grant=${encodeURIComponent(minted.grant)}`,
  );
  assert.equal(response.status, 401, 'successful one-time grant cannot be replayed');
});

test('attachment-view grant mint and redemption preserve tenant and revocation boundaries', async () => {
  const ownerToken = await signup('grant-revocation@scopeweave.test');
  const projectId = await createProject(ownerToken, 'Revocation Project');
  const attachmentId = await uploadReadyAttachment(projectId, ownerToken, 'task-r');
  const outsiderToken = await signup('grant-outsider@scopeweave.test');
  await createProject(outsiderToken, 'Other Tenant Project');

  let response = await mintAttachmentViewGrant(projectId, attachmentId, outsiderToken);
  assert.equal(response.status, 404, 'cross-tenant callers cannot learn whether the attachment exists');

  response = await mintAttachmentViewGrant(projectId, Number(attachmentId) + 10_000, ownerToken);
  assert.equal(response.status, 404, 'unknown resources use the same nondisclosing mint failure');

  response = await mintAttachmentViewGrant(projectId, attachmentId, ownerToken);
  assert.equal(response.status, 201);
  const { grant } = await response.json();
  const owner = db.prepare('SELECT id FROM users WHERE email = ?').get('grant-revocation@scopeweave.test');
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(owner.id);

  response = await app.request(
    `/api/projects/${projectId}/attachments/${attachmentId}/view?grant=${encodeURIComponent(grant)}`,
  );
  assert.equal(response.status, 401, 'logout-all/password-style session revocation invalidates an unconsumed grant');
});

test('header-capable clients keep bearer and PAT attachment access without URL credentials', async () => {
  const ownerToken = await signup('grant-header@scopeweave.test');
  const projectId = await createProject(ownerToken, 'Header Compatibility Project');
  const attachmentId = await uploadReadyAttachment(projectId, ownerToken, 'task-h');

  let response = await app.request(`/api/projects/${projectId}/attachments/${attachmentId}/view`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(response.status, 302, 'normal Authorization-header JWT access remains supported');

  response = await jsonRequest('/api/tokens', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'attachment-reader' },
  });
  assert.equal(response.status, 200);
  const pat = (await response.json()).token;

  response = await app.request(`/api/projects/${projectId}/attachments/${attachmentId}/view`, {
    headers: { authorization: `Bearer ${pat}` },
  });
  assert.equal(response.status, 302, 'PAT access remains in the Authorization header rather than a query string');
});