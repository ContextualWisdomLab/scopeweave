// Final exact-head branch cases that remain observable through public API and
// integration boundaries after the broader residual suite. These are real
// authorization, malformed-auth, attachment-metadata, and tenant-isolation
// behaviors rather than assertion-only coverage probes.
import assert from 'node:assert/strict';
import { File } from 'node:buffer';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '1000';
process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
delete process.env.ORCHESTRATOR_URL;
delete process.env.CLEARFOLIO_URL;
delete process.env.OIDC_ISSUER;

const [{ app }, { db }, { submitJob }] = await Promise.all([
  import('../../server/app.mjs'),
  import('../../server/db.mjs'),
  import('../../server/clearfolio.mjs'),
]);

const jsonBody = (value) => JSON.stringify(value);
const authHeaders = (token) => ({ authorization: `Bearer ${token}` });
const req = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return app.request(path, { ...options, headers });
};
const status = async (expected, promise, label) => {
  const response = await promise;
  assert.equal(response.status, expected, label);
  return response;
};

let response = await req('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'final-owner@example.com', password: 'password123', name: 'Final Owner' }),
});
assert.equal(response.status, 200);
const ownerToken = (await response.json()).token;
const ownerAuth = authHeaders(ownerToken);
const ownerMe = await (await req('/api/me', { headers: ownerAuth })).json();
const ownerId = ownerMe.user.id;
const orgId = ownerMe.orgs[0].id;
db.prepare("UPDATE orgs SET plan = 'pro' WHERE id = ?").run(orgId);

response = await req('/api/auth/signup', {
  method: 'POST',
  body: jsonBody({ email: 'final-viewer@example.com', password: 'password123' }),
});
const viewerAuth = authHeaders((await response.json()).token);
const viewerId = (await (await req('/api/me', { headers: viewerAuth })).json()).user.id;
db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(orgId, viewerId, 'viewer');

response = await req('/api/projects', {
  method: 'POST',
  headers: ownerAuth,
  body: jsonBody({ name: 'Final Branch Project', orgId }),
});
assert.equal(response.status, 200);
const projectId = (await response.json()).id;

// Calendar clients that supply neither bearer nor query credentials fail closed.
await status(401, req(`/api/projects/${projectId}/calendar.ics`), 'calendar missing credentials');

// Read-only members cannot mutate roster roles or remove another member. These
// checks happen before target lookup, preserving the management boundary.
await status(403, req(`/api/orgs/${orgId}/members/${ownerId}`, {
  method: 'PATCH',
  headers: viewerAuth,
  body: jsonBody({ role: 'member' }),
}), 'viewer cannot change member role');
await status(403, req(`/api/orgs/${orgId}/members/${ownerId}`, {
  method: 'DELETE',
  headers: viewerAuth,
}), 'viewer cannot remove member');

// Empty browser-supplied filename/MIME metadata is normalized by the existing
// attachment contract and remains viewable through a valid query JWT.
const unnamedFile = new FormData();
unnamedFile.append('file', new File(['unnamed document'], '', { type: '' }));
response = await app.request(`/api/projects/${projectId}/attachments`, {
  method: 'POST',
  headers: ownerAuth,
  body: unnamedFile,
});
assert.equal(response.status, 200);
const unnamedAttachmentId = (await response.json()).id;
response = await req(`/api/projects/${projectId}/attachments/${unnamedAttachmentId}/view?token=${encodeURIComponent(ownerToken)}`);
assert.equal(response.status, 302);
await status(404, req(`/api/projects/${projectId}/attachments/999999`, {
  method: 'DELETE',
  headers: ownerAuth,
}), 'missing attachment delete');

// A mock Clearfolio artifact with no MIME metadata must still be served with a
// safe binary fallback rather than an absent or malformed Content-Type.
const rawJob = await submitJob(orgId, ownerId, {
  name: 'raw.bin',
  mime: '',
  bytes: Buffer.from('raw artifact'),
});
response = await req(`/api/mock-clearfolio/${rawJob.jobId}`);
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type') || '', /^application\/octet-stream\b/);

// Share-list tenant isolation returns not-found for an inaccessible project.
await status(404, req('/api/projects/999999/shares', { headers: ownerAuth }), 'share list missing project');

console.log('app final branch coverage: ok');
