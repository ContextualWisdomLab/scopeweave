import assert from 'node:assert';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
const { app } = await import('../../server/app.mjs');

const req = (path, opts = {}) =>
  app.request(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
const body = (value) => JSON.stringify(value);

let response = await req('/api/auth/signup', {
  method: 'POST',
  body: body({ email: 'ssrf-owner@example.test', password: 'password123', name: 'SSRF owner' }),
});
assert.equal(response.status, 200, 'signup succeeds');
const { token } = await response.json();
const auth = { authorization: `Bearer ${token}` };

response = await req('/api/me', { headers: auth });
assert.equal(response.status, 200, 'owner workspace is available');
const orgId = (await response.json()).orgs[0].id;

for (const url of [
  'https://[fc00::1]/hook',
  'https://[fe80::1]/hook',
  'https://[::ffff:127.0.0.1]/hook',
  'http://example.com/hook',
]) {
  response = await req(`/api/orgs/${orgId}/webhooks`, {
    method: 'POST',
    headers: auth,
    body: body({ url, events: ['project.update'] }),
  });
  assert.equal(response.status, 400, `${url} must fail closed at webhook registration`);
}

response = await req(`/api/orgs/${orgId}/webhooks`, {
  method: 'POST',
  headers: auth,
  body: body({ url: 'https://example.com/hook', events: ['project.update'] }),
});
assert.equal(response.status, 200, 'public HTTPS webhook registration remains available');

console.log('✓ webhook SSRF address-family and transport regression tests passed');
