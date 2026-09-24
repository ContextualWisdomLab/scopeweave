// scrypt password type-safety — non-string JSON bodies must not throw.
// Run: node tests/unit/auth-password.test.mjs
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

const SECRET = '0123456789abcdef0123456789abcdef';

const script = `
import assert from 'node:assert';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
const originalScryptSync = crypto.scryptSync;
let scryptCalls = 0;
crypto.scryptSync = (...args) => {
  scryptCalls += 1;
  return originalScryptSync(...args);
};
syncBuiltinESMExports();

const { hashPassword, verifyPassword } = await import('./server/auth.mjs');
const { db } = await import('./server/db.mjs');
const { app } = await import('./server/app.mjs');

const stored = hashPassword('correct-horse');
assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/);
assert.equal(verifyPassword('correct-horse', stored), true);
assert.equal(verifyPassword('wrong', stored), false);
assert.equal(verifyPassword(['correct-horse'], stored), false, 'array must not coerce to a real password');

// Non-string bodies (object/array/null/number) must not throw TypeError from scryptSync.
// verifyPassword rejects them outright (false) — never treat as empty-string password.
for (const bad of [{}, [], null, undefined, 12, true]) {
  assert.doesNotThrow(() => hashPassword(bad), String(bad));
  assert.equal(verifyPassword(bad, stored), false, 'non-string never verifies a real password');
}

// Empty string is a distinct string path; non-strings must not verify against it.
const empty = hashPassword('');
assert.equal(verifyPassword('', empty), true);
assert.equal(verifyPassword({}, empty), false, 'object body must not match empty-password hash');
assert.equal(verifyPassword([], empty), false, 'empty array must not coerce to an empty password');
assert.equal(verifyPassword(null, empty), false);
assert.equal(verifyPassword({ evil: true }, stored), false);

// Count the actual scrypt boundary used by the login handler without exposing
// mutable test state from production modules. The child process and in-memory DB
// isolate this fixture from application state.
db.prepare('DELETE FROM users WHERE email = ?').run('timing@example.com');
db.prepare('INSERT INTO users(email, password_hash) VALUES(?, ?)').run(
  'timing@example.com',
  hashPassword('real-password')
);

const testCases = [
  { name: 'existing user + wrong string password', email: 'timing@example.com', password: 'wrong' },
  { name: 'missing user + string password', email: 'missing@example.com', password: 'wrong' },
  { name: 'existing user + non-string password', email: 'timing@example.com', password: { obj: true } },
  { name: 'missing user + non-string password', email: 'missing@example.com', password: { obj: true } },
];

for (const tc of testCases) {
  scryptCalls = 0;
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: tc.email, password: tc.password })
  });
  const res = await app.fetch(req);
  assert.equal(res.status, 401, \`Expected 401 for \${tc.name}\`);
  assert.equal(scryptCalls, 1, \`login must execute exactly one scrypt verification for \${tc.name}\`);
}

scryptCalls = 0;
const reqSuccess = new Request('http://localhost/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'timing@example.com', password: 'real-password' })
});
const resSuccess = await app.fetch(reqSuccess);
assert.equal(resSuccess.status, 200, 'Expected 200 for correct credentials');
assert.equal(scryptCalls, 1, 'successful login must execute exactly one scrypt verification');

crypto.scryptSync = originalScryptSync;
syncBuiltinESMExports();

console.log('✓ auth login verification-work checks passed');
console.log('✓ auth password type-safety tests passed');
`;

const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SCOPEWEAVE_JWT_SECRET: SECRET,
    SCOPEWEAVE_DB: ':memory:',
  },
  encoding: 'utf8',
});

assert.equal(result.status, 0, result.stderr || result.stdout);
process.stdout.write(result.stdout);
