import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

const jsonRequest = (path, options = {}) => app.request(path, {
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});

const signup = await jsonRequest('/api/auth/signup', {
  method: 'POST',
  body: JSON.stringify({ email: 'viewer-auth@example.com', password: 'password123', name: 'Attachment Viewer' }),
});
assert.equal(signup.status, 200, 'fixture user signs up');
const { token } = await signup.json();
const auth = { authorization: `Bearer ${token}` };

const projectResponse = await jsonRequest('/api/projects', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ name: 'Attachment auth fixture' }),
});
assert.equal(projectResponse.status, 200, 'fixture project is created');
const project = await projectResponse.json();

const upload = new FormData();
upload.append('file', new Blob(['%PDF-auth-boundary'], { type: 'application/pdf' }), 'auth-boundary.pdf');
upload.append('taskId', 'security-task');
const uploadResponse = await app.request(`/api/projects/${project.id}/attachments`, {
  method: 'POST',
  headers: auth,
  body: upload,
});
assert.equal(uploadResponse.status, 200, 'fixture attachment uploads');
const attachment = await uploadResponse.json();

const leakedQueryCredential = await jsonRequest(
  `/api/projects/${project.id}/attachments/${attachment.id}/view?token=${encodeURIComponent(token)}`,
);
assert.equal(leakedQueryCredential.status, 401, 'general session JWT is never accepted from an attachment-view URL');

const viewResponse = await jsonRequest(
  `/api/projects/${project.id}/attachments/${attachment.id}/view`,
  { headers: auth },
);
assert.equal(viewResponse.status, 200, 'attachment view link is issued through Authorization-header authentication');
assert.match(viewResponse.headers.get('content-type') || '', /^application\/json\b/, 'view endpoint returns JSON, not a credential-bearing redirect');
const viewPayload = await viewResponse.json();
assert.equal(typeof viewPayload.url, 'string', 'view response returns an artifact URL');
assert.ok(viewPayload.url.length > 0, 'artifact URL is non-empty');
assert.equal(viewPayload.url.includes(token), false, 'artifact URL never embeds the general session JWT');

const unauthenticated = await jsonRequest(`/api/projects/${project.id}/attachments/${attachment.id}/view`);
assert.equal(unauthenticated.status, 401, 'view endpoint rejects missing Authorization');

const secondSignup = await jsonRequest('/api/auth/signup', {
  method: 'POST',
  body: JSON.stringify({ email: 'other-viewer@example.com', password: 'password123', name: 'Other Viewer' }),
});
const otherToken = (await secondSignup.json()).token;
const crossTenant = await jsonRequest(
  `/api/projects/${project.id}/attachments/${attachment.id}/view`,
  { headers: { authorization: `Bearer ${otherToken}` } },
);
assert.equal(crossTenant.status, 404, 'cross-tenant attachment view remains nondisclosing');

console.log('attachment view authentication boundary tests passed');
