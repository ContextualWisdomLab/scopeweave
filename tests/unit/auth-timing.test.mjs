// Test for timing attack dummy hash logic.
// Run: node tests/unit/auth-timing.test.mjs
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

const script = `
import assert from 'node:assert';
import { app } from './server/app.mjs';

// If we pass an invalid password type (like an object) or don't pass one, it shouldn't crash
// and should return 401 instead of 500.

const req = async (payload) => {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res;
};

// 1. Missing user and missing password
const res1 = await req({ email: 'nonexistent@example.com' });
assert.equal(res1.status, 401, 'missing password should return 401');

// 2. Missing user and object password
const res2 = await req({ email: 'nonexistent@example.com', password: { malicious: true } });
assert.equal(res2.status, 401, 'object password should return 401');

console.log('✓ auth timing attack mitigation tests passed');
`;

const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
  cwd: process.cwd(),
  env: { ...process.env, SCOPEWEAVE_DB: ':memory:', SCOPEWEAVE_JWT_SECRET: '0123456789abcdef0123456789abcdef' },
  encoding: 'utf8',
});

assert.equal(result.status, 0, result.stderr || result.stdout);
process.stdout.write(result.stdout);
