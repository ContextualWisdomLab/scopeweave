// Calendar runtime abuse-control regression — runs in its own process with a
// deliberately small per-client rate limit so runtime-only routes exercise the
// same boundary as the core API without collapsing auth checks into one bucket.
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '2';
process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '600000';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/runtime_app.mjs');

const json = (value) => JSON.stringify(value);
const req = (path, { ip = '203.0.113.10', headers = {}, ...options } = {}) => app.request(path, {
  ...options,
  headers: {
    'content-type': 'application/json',
    'x-forwarded-for': ip,
    ...headers,
  },
});

// Prepare one real project through the public fallback/core API. A dedicated
// setup address keeps fixture creation from consuming either runtime test bucket.
let response = await req('/api/auth/signup', {
  ip: '192.0.2.10',
  method: 'POST',
  body: json({ email: 'calendar-limit-owner@example.com', password: 'password123', name: 'Owner' }),
});
assert.equal(response.status, 200, 'fixture owner signs up');
const { token } = await response.json();
const auth = { authorization: `Bearer ${token}` };

response = await req('/api/projects', {
  ip: '192.0.2.10',
  method: 'POST',
  headers: auth,
  body: json({ name: 'Rate-limited calendar project' }),
});
assert.equal(response.status, 200, 'fixture project is created');
const project = await response.json();

// Subscription-secret probes terminate on the runtime app and therefore must
// not bypass the same per-IP abuse ceiling that protects the legacy/core API.
const feedPath = `/api/projects/${project.id}/calendar.ics?subscription=invalid-secret-probe`;
for (let attempt = 0; attempt < 2; attempt += 1) {
  response = await req(feedPath, { ip: '203.0.113.20' });
  assert.equal(response.status, 401, 'invalid calendar secret fails closed below the abuse ceiling');
}
response = await req(feedPath, { ip: '203.0.113.20' });
assert.equal(response.status, 429, 'third calendar-secret probe is rate-limited');
assert.ok(response.headers.get('retry-after'), 'runtime rate limit exposes Retry-After');

// Authenticated runtime management must use the caller's own bucket. The first
// client reaches its limit as 429, while an unrelated client remains usable.
for (let attempt = 0; attempt < 2; attempt += 1) {
  response = await req(`/api/projects/${project.id}/calendar-subscriptions`, {
    ip: '198.51.100.20',
    headers: auth,
  });
  assert.equal(response.status, 200, 'authenticated calendar management succeeds below its client limit');
}
response = await req(`/api/projects/${project.id}/calendar-subscriptions`, {
  ip: '198.51.100.20',
  headers: auth,
});
assert.equal(response.status, 429, 'calendar management reports rate limiting rather than false 401');
assert.ok(response.headers.get('retry-after'), 'management rate limit exposes Retry-After');

response = await req(`/api/projects/${project.id}/calendar-subscriptions`, {
  ip: '198.51.100.21',
  headers: auth,
});
assert.equal(response.status, 200, 'a separate client is not locked out by another calendar client');

// Preserve the existing PAT contract while removing the internal /api/me hop.
response = await req('/api/tokens', {
  ip: '192.0.2.11',
  method: 'POST',
  headers: auth,
  body: json({ name: 'calendar-runtime-test' }),
});
assert.equal(response.status, 200, 'fixture PAT is issued through the core API');
const { token: personalAccessToken } = await response.json();
response = await req(`/api/projects/${project.id}/calendar-subscriptions`, {
  ip: '198.51.100.22',
  headers: { authorization: `Bearer ${personalAccessToken}` },
});
assert.equal(response.status, 200, 'calendar management preserves PAT authentication');

console.log('calendar subscription rate-limit tests passed');
