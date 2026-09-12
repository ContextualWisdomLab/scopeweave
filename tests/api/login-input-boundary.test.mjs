import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';

const { app } = await import('../../server/app.mjs');

async function login(email, password = 'password123') {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

for (const [label, email] of [
  ['object', { address: 'unknown@example.test' }],
  ['array', ['unknown@example.test']],
]) {
  const response = await login(email);
  assert.equal(response.status, 401, `${label} email must fail through the normal login boundary`);
  assert.deepEqual(
    await response.json(),
    { error: 'invalid credentials' },
    `${label} email must not escape as an internal binding error`,
  );
}

console.log('✓ login input boundary tests passed');
