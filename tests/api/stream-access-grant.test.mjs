// Runtime regression for the stream access-grant migration in #413.
// Exercises Hono, SQLite grant persistence, tenant authorization, session
// revocation, one-time redemption, and the actual SSE response boundary.
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

async function issueStreamGrant(token, projectId) {
  const response = await jsonRequest(`/api/projects/${projectId}/access-grants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: jsonBody({ purpose: 'stream' }),
  });
  assert.equal(response.status, 201, 'authorized member receives a stream grant');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const issued = await response.json();
  assert.equal(issued.purpose, 'stream');
  assert.ok(Number.isSafeInteger(issued.expiresAtMs) && issued.expiresAtMs > Date.now());
  assert.match(issued.url, new RegExp(`^/api/projects/${projectId}/stream\\?grant=[A-Za-z0-9_-]{43}$`));
  assert.equal(issued.url.includes('token='), false);
  assert.equal(issued.url.includes(token), false, 'broad JWT never appears in the SSE URL');
  return issued;
}

async function readConnectedPreamble(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream\b/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), ': connected\n\n');
  await reader.cancel();
}

const ownerToken = await signup('stream-owner@example.com');
const project = await createProject(ownerToken, 'Stream grant project');
const secondProject = await createProject(ownerToken, 'Second stream project');

let issued = await issueStreamGrant(ownerToken, project.id);

// A valid broad session JWT in the old query parameter is no longer accepted.
let response = await app.request(`/api/projects/${project.id}/stream?token=${encodeURIComponent(ownerToken)}`);
assert.equal(response.status, 401, 'legacy broad JWT query transport is rejected');
assert.equal(response.headers.get('cache-control'), 'private, no-store');
assert.equal(response.headers.get('referrer-policy'), 'no-referrer');

// Wrong-resource probes do not consume the one-time grant.
const issuedUrl = new URL(issued.url, 'http://localhost');
const grantSecret = issuedUrl.searchParams.get('grant');
response = await app.request(`/api/projects/${secondProject.id}/stream?grant=${encodeURIComponent(grantSecret)}`);
assert.equal(response.status, 401, 'stream grant is bound to its exact project');
assert.equal(response.headers.get('cache-control'), 'private, no-store');

response = await app.request(issued.url);
await readConnectedPreamble(response);

response = await app.request(issued.url);
assert.equal(response.status, 401, 'consumed stream grant cannot be replayed');
assert.equal(response.headers.get('cache-control'), 'private, no-store');

// Non-browser API clients keep Authorization-header access. The direct path
// uses the strict database-backed session check rather than the old query-only
// verifyToken shortcut.
response = await app.request(`/api/projects/${project.id}/stream`, {
  headers: { authorization: `Bearer ${ownerToken}` },
});
await readConnectedPreamble(response);

// The access-grant exchange remains tenant-nondisclosing.
const outsiderToken = await signup('stream-outsider@example.com');
response = await jsonRequest(`/api/projects/${project.id}/access-grants`, {
  method: 'POST',
  headers: { authorization: `Bearer ${outsiderToken}` },
  body: jsonBody({ purpose: 'stream' }),
});
assert.equal(response.status, 404, 'outsider cannot discover the project by minting a stream grant');
assert.equal(response.headers.get('cache-control'), 'no-store');

// Ambiguous or malformed credential shapes fail closed without opening SSE.
for (const query of [
  `grant=${'C'.repeat(43)}&grant=${'D'.repeat(43)}`,
  `grant=${'E'.repeat(43)}&next=/admin`,
  'grant=short',
  `token=${encodeURIComponent(ownerToken)}&grant=${'F'.repeat(43)}`,
]) {
  response = await app.request(`/api/projects/${project.id}/stream?${query}`);
  assert.equal(response.status, 401, `unsafe stream query is rejected: ${query}`);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
}

// Revocation before mint prevents a former session from obtaining fresh grants.
const revoke = await jsonRequest('/api/auth/logout-all', {
  method: 'POST',
  headers: { authorization: `Bearer ${ownerToken}` },
});
assert.equal(revoke.status, 200, 'logout-all revokes the owner session');
response = await jsonRequest(`/api/projects/${project.id}/access-grants`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ownerToken}` },
  body: jsonBody({ purpose: 'stream' }),
});
assert.equal(response.status, 401, 'revoked session cannot mint a new stream grant');

console.log('stream access-grant runtime contract ok');
