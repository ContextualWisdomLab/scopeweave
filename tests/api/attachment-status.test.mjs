import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_ATTACHMENT_STATUS_CONCURRENCY = '2';
process.env.SCOPEWEAVE_ATTACHMENT_STATUS_TIMEOUT_MS = '500';

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');
const jsonRequest = (path, options = {}) => app.request(path, {
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});

async function upload(projectId, token, taskId) {
  const form = new FormData();
  form.append('file', new Blob([`content-${taskId}`], { type: 'text/plain' }), `${taskId}.txt`);
  form.set('taskId', taskId);
  const response = await app.request(`/api/projects/${projectId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('attachment listing refreshes without N+1 queries or internal identifier leakage', async () => {
  let response = await jsonRequest('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email: 'attachments@scopeweave.test', password: 'password123', name: 'Attachments' }),
  });
  assert.equal(response.status, 200);
  const token = (await response.json()).token;
  const auth = { authorization: `Bearer ${token}` };
  response = await jsonRequest('/api/me', { headers: auth });
  const userId = (await response.json()).user.id;
  response = await jsonRequest('/api/projects', {
    method: 'POST', headers: auth, body: JSON.stringify({ name: 'Attachment Status Project' }),
  });
  assert.equal(response.status, 200);
  const projectId = (await response.json()).id;

  const first = await upload(projectId, token, 'task-a');
  const second = await upload(projectId, token, 'task-b');
  db.prepare("UPDATE attachments SET status = 'PENDING' WHERE id IN (?, ?)").run(first.id, second.id);
  db.prepare('INSERT INTO attachments(project_id,task_id,name,mime,size,job_id,status,created_by) VALUES(?,?,?,?,?,?,?,?)')
    .run(projectId, 'task-missing', 'missing.txt', 'text/plain', 1, '', 'PENDING', userId);

  response = await jsonRequest(`/api/projects/${projectId}/attachments?taskId=task-a`, { headers: auth });
  assert.equal(response.status, 200);
  let attachments = (await response.json()).attachments;
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].taskId, 'task-a');
  assert.equal(attachments[0].status, 'SUCCEEDED');
  assert.equal(Object.hasOwn(attachments[0], 'jobId'), false);

  response = await jsonRequest(`/api/projects/${projectId}/attachments`, { headers: auth });
  assert.equal(response.status, 200);
  attachments = (await response.json()).attachments;
  assert.equal(attachments.length, 3);
  assert.equal(attachments.every((row) => !Object.hasOwn(row, 'jobId')), true);
  assert.equal(attachments.find((row) => row.taskId === 'task-b').status, 'SUCCEEDED');
  assert.equal(attachments.find((row) => row.taskId === 'task-missing').status, 'PENDING');

  response = await jsonRequest('/api/metrics');
  const metrics = await response.json();
  assert.equal(metrics.attachmentStatusRefreshAttempted, 2);
  assert.equal(metrics.attachmentStatusRefreshChanged, 2);
  assert.equal(metrics.attachmentStatusRefreshFailed, 0);
  assert.equal(metrics.attachmentStatusRefreshDeferred, 1);

  response = await jsonRequest('/api/metrics?format=prometheus');
  const prometheus = await response.text();
  assert.match(prometheus, /scopeweave_attachment_status_refresh_attempted 2/);
  assert.match(prometheus, /scopeweave_attachment_status_refresh_changed 2/);
  assert.match(prometheus, /scopeweave_attachment_status_refresh_failed 0/);
  assert.match(prometheus, /scopeweave_attachment_status_refresh_deferred 1/);

  const source = readFileSync('server/app.mjs', 'utf8');
  const routeStart = source.indexOf("app.get('/api/projects/:id/attachments'");
  const routeEnd = source.indexOf('// 열람:', routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.equal((route.match(/a\.job_id AS jobId/g) || []).length, 2);
  assert.doesNotMatch(route, /SELECT job_id FROM attachments/);
  assert.match(route, /rows\.map\(\(\{ jobId: _internalJobId, \.\.\.publicRow \}\) => publicRow\)/);
});
