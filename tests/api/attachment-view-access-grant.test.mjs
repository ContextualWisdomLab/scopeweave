// Runtime regression for the attachment-view access-grant migration in #413.
// This test intentionally exercises the real Hono routes, SQLite persistence,
// tenant checks, Clearfolio mock, and one-time redemption contract together.
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

const jsonRequest = (path, options = {}) => app.request(path, {
  ...options,
  headers: {
    'content-type': 'application/json',
    ...(options.headers || {}),
  },
});
const jsonBody = (value) => JSON.stringify(value);

async function signup(email) {
  const response = await jsonRequest('/api/auth/signup', {
    method: 'POST',
    body: jsonBody({ email, password: 'password123', name: email.split('@')[0] }),
  });
  assert.equal(response.status, 200, `signup succeeds for ${email}`);
  return (await response.json()).token;
}

async function createProject(token, name) {
  const response = await jsonRequest('/api/projects', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: jsonBody({ name }),
  });
  assert.equal(response.status, 200, `project creation succeeds for ${name}`);
  return response.json();
}

async function uploadReadyAttachment(token, projectId, name) {
  const form = new FormData();
  form.append('file', new File([`evidence:${name}`], name, { type: 'text/plain' }));
  const response = await app.request(`/api/projects/${projectId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(response.status, 200, `attachment upload succeeds for ${name}`);
  const uploaded = await response.json();
  assert.equal(uploaded.status, 'SUCCEEDED', 'Clearfolio test adapter makes the artifact immediately viewable');
  return uploaded;
}

function assertPrivateGrantResponse(response, message) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store', `${message}: cache is disabled`);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer', `${message}: referrer cannot disclose the grant`);
}

const ownerToken = await signup('grant-owner@example.com');
const project = await createProject(ownerToken, 'Grant runtime project');
const attachment = await uploadReadyAttachment(ownerToken, project.id, 'design-evidence.txt');
const secondAttachment = await uploadReadyAttachment(ownerToken, project.id, 'other-evidence.txt');

// The browser exchanges its broad session credential through the Authorization
// header. The response exposes only a one-time, resource-bound URL and metadata;
// it never returns or embeds the broad JWT.
let response = await jsonRequest(`/api/projects/${project.id}/access-grants`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ownerToken}` },
  body: jsonBody({ purpose: 'attachment_view', attachmentId: attachment.id }),
});
assert.equal(response.status, 201, 'ready attachment gets a one-time view grant');
assert.equal(response.headers.get('cache-control'), 'no-store', 'grant exchange response is not cacheable');
assert.equal(response.headers.get('referrer-policy'), 'no-referrer', 'grant exchange does not propagate referrers');
const issued = await response.json();
assert.equal(issued.purpose, 'attachment_view');
assert.ok(/^agr_[a-f0-9]{32}$/.test(issued.grantId), 'non-secret grant correlation id is returned');
assert.ok(Number.isSafeInteger(issued.expiresAtMs) && issued.expiresAtMs > Date.now(), 'expiry is explicit');
assert.equal(typeof issued.url, 'string');
assert.match(issued.url, new RegExp(`^/api/projects/${project.id}/attachments/${attachment.id}/view\\?grant=[A-Za-z0-9_-]{43}$`));
assert.equal(issued.url.includes('token='), false, 'legacy broad-token query parameter is absent');
assert.equal(issued.url.includes(ownerToken), false, 'session JWT is never copied into the view URL');

// The old broad session JWT transport is now rejected even when the JWT itself
// is valid. Header credentials remain available to clients that can set them.
response = await app.request(`/api/projects/${project.id}/attachments/${attachment.id}/view?token=${encodeURIComponent(ownerToken)}`);
assert.equal(response.status, 401, 'valid session JWT is rejected in a query string');
assertPrivateGrantResponse(response, 'legacy token rejection');

response = await app.request(`/api/projects/${project.id}/attachments/${secondAttachment.id}/view`, {
  headers: { authorization: `Bearer ${ownerToken}` },
  redirect: 'manual',
});
assert.equal(response.status, 302, 'Authorization-header session access remains supported');
assert.equal(response.headers.get('location'), `/api/mock-clearfolio/mockcf-${secondAttachment.id}`.replace(`mockcf-${secondAttachment.id}`, 'mockcf-2'), 'header-auth view redirects to Clearfolio artifact');

// A wrong resource binding must fail without consuming the grant. The original
// bound route can still redeem once afterwards.
const issuedUrl = new URL(issued.url, 'http://localhost');
const grantSecret = issuedUrl.searchParams.get('grant');
response = await app.request(`/api/projects/${project.id}/attachments/${secondAttachment.id}/view?grant=${encodeURIComponent(grantSecret)}`, { redirect: 'manual' });
assert.equal(response.status, 401, 'grant cannot be used for another attachment');
assertPrivateGrantResponse(response, 'wrong attachment rejection');

response = await app.request(issued.url, { redirect: 'manual' });
assert.equal(response.status, 302, 'bound grant redirects exactly once');
assert.equal(response.headers.get('location'), '/api/mock-clearfolio/mockcf-1');
assertPrivateGrantResponse(response, 'successful grant redemption');
assert.equal(response.headers.get('location')?.includes(grantSecret), false, 'grant secret is never forwarded downstream');

response = await app.request(issued.url, { redirect: 'manual' });
assert.equal(response.status, 401, 'one-time grant replay is rejected');
assertPrivateGrantResponse(response, 'replay rejection');

// Tenant nondisclosure applies at mint time: another user sees neither the
// project nor attachment through the exchange endpoint.
const outsiderToken = await signup('grant-outsider@example.com');
response = await jsonRequest(`/api/projects/${project.id}/access-grants`, {
  method: 'POST',
  headers: { authorization: `Bearer ${outsiderToken}` },
  body: jsonBody({ purpose: 'attachment_view', attachmentId: attachment.id }),
});
assert.equal(response.status, 404, 'cross-tenant mint is indistinguishable from a missing resource');
assert.equal(response.headers.get('cache-control'), 'no-store', 'failed exchange is not cacheable');

console.log('attachment-view access-grant runtime contract ok');
