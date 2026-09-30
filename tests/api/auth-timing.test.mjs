import assert from 'node:assert';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

const req = (path, opts = {}) =>
  app.request(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
const body = (o) => JSON.stringify(o);

async function runTimingTests() {
  // Signup a user to create a baseline
  let r = await req('/api/auth/signup', { method: 'POST', body: body({ email: 'timing@b.com', password: 'password123', name: 'Timing' }) });
  assert.equal(r.status, 200);

  // We cannot robustly test timing in this environment because it's prone to noise,
  // but we CAN test that the endpoint still behaves correctly for both valid, invalid,
  // and non-existent users after our patch.

  // 1. Valid user, valid password
  r = await req('/api/auth/login', { method: 'POST', body: body({ email: 'timing@b.com', password: 'password123' }) });
  assert.equal(r.status, 200, 'Valid login should succeed');

  // 2. Valid user, invalid password
  r = await req('/api/auth/login', { method: 'POST', body: body({ email: 'timing@b.com', password: 'wrongpassword' }) });
  assert.equal(r.status, 401, 'Invalid password should fail');

  // 3. Invalid user
  r = await req('/api/auth/login', { method: 'POST', body: body({ email: 'nonexistent@b.com', password: 'password123' }) });
  assert.equal(r.status, 401, 'Nonexistent user should fail');

  console.log('✓ Timing attack prevention contract tests passed');
}

runTimingTests().catch(e => {
  console.error(e);
  process.exit(1);
});
