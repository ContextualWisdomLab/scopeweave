// scrypt password type-safety — non-string JSON bodies must not throw.
// Run: node tests/unit/auth-password.test.mjs
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

const SECRET = '0123456789abcdef0123456789abcdef';

const script = `
import assert from 'node:assert';
import { hashPassword, verifyPassword } from './server/auth.mjs';

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

// Malformed or truncated persisted representations fail closed before any
// timing-safe equality result can be mistaken for a valid credential.
for (const malformed of [null, undefined, '', 'salt-only', 'salt:', ':hash']) {
  assert.equal(verifyPassword('correct-horse', malformed), false, 'missing salt/hash never verifies');
}
const [salt] = stored.split(':');
assert.equal(verifyPassword('correct-horse', `${salt}:00`), false, 'wrong digest length fails closed');
assert.equal(verifyPassword('correct-horse', `${salt}:not-hex`), false, 'invalid hex digest fails closed');

// Empty string is a distinct string path; non-strings must not verify against it.
const empty = hashPassword('');
assert.equal(verifyPassword('', empty), true);
assert.equal(verifyPassword({}, empty), false, 'object body must not match empty-password hash');
assert.equal(verifyPassword([], empty), false, 'empty array must not coerce to an empty password');
assert.equal(verifyPassword(null, empty), false);
assert.equal(verifyPassword({ evil: true }, stored), false);

console.log('✓ auth password type-safety tests passed');
`;

const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
  cwd: process.cwd(),
  env: { ...process.env, SCOPEWEAVE_JWT_SECRET: SECRET },
  encoding: 'utf8',
});

assert.equal(result.status, 0, result.stderr || result.stdout);
process.stdout.write(result.stdout);
