// Webhook target validation at the authenticated registration boundary.
import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');
const json = (value) => JSON.stringify(value);
const req = (path, options = {}) => app.request(path, {
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});

let response = await req('/api/auth/signup', {
  method: 'POST',
  body: json({ email: 'webhook-security@example.test', password: 'password123', name: 'Webhook Security' }),
});
assert.equal(response.status, 200, 'test owner signup');
const { token } = await response.json();
const auth = { authorization: `Bearer ${token}` };

response = await req('/api/me', { headers: auth });
assert.equal(response.status, 200, 'owner profile');
const orgId = (await response.json()).orgs[0].id;

async function register(url) {
  return req(`/api/orgs/${orgId}/webhooks`, {
    method: 'POST',
    headers: auth,
    body: json({ url, events: ['project.update'] }),
  });
}

for (const url of [
  'http://127.0.0.1:8080/hook',
  'http://10.0.0.1/hook',
  'http://172.16.0.1/hook',
  'http://192.168.0.1/hook',
  'http://169.254.169.254/latest/meta-data',
  'http://0.0.0.0/hook',
  'http://[::1]/hook',
  'http://[fc00::1]/hook',
  'http://[fe80::1]/hook',
  'http://[::ffff:127.0.0.1]/hook',
]) {
  response = await register(url);
  assert.equal(response.status, 400, `${url} must be rejected`);
}

// A literal public address exercises the allow path without making this test
// depend on external DNS. Registration itself does not perform a delivery.
response = await register('https://93.184.216.34/hook');
assert.equal(response.status, 200, 'public literal target can be registered');

console.log('✓ webhook SSRF registration tests passed');
