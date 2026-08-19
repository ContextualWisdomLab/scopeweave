import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.CLEARFOLIO_URL = '';

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

const jsonRequest = (path, options = {}) => app.request(path, {
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});

test('empty multipart filenames are rejected before attachment metadata is persisted', async () => {
  let response = await jsonRequest('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      email: 'unnamed-attachment@scopeweave.test',
      password: 'password123',
      name: 'Unnamed Attachment',
    }),
  });
  assert.equal(response.status, 200);
  const token = (await response.json()).token;
  const auth = { authorization: `Bearer ${token}` };

  response = await jsonRequest('/api/projects', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'Unnamed Attachment Project' }),
  });
  assert.equal(response.status, 200);
  const projectId = (await response.json()).id;

  const form = new FormData();
  form.append('file', new Blob(['unnamed'], { type: 'text/plain' }), '');
  form.set('taskId', 'unnamed-task');
  response = await app.request(`/api/projects/${projectId}/attachments`, {
    method: 'POST',
    headers: auth,
    body: form,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'multipart file required' });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE project_id = ?').get(projectId).count,
    0,
    'a multipart field without a filename must never create attachment metadata',
  );
});
