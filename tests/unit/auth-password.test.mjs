// Password verification boundary tests: type safety plus login control-flow parity.
// Run: node tests/unit/auth-password.test.mjs
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SECRET = '0123456789abcdef0123456789abcdef';

// Lock the missing-user quick-exit mechanism directly instead of relying on a
// scheduler-dependent elapsed-time threshold. A missing lookup must still call
// verifyPassword with dummy storage before its 401 return.
const appSource = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');
const loginStart = appSource.indexOf("app.post('/api/auth/login'");
const nextRoute = appSource.indexOf("app.get('/api/me'", loginStart);
assert.ok(loginStart >= 0 && nextRoute > loginStart, 'login route must be discoverable');
const loginRoute = appSource.slice(loginStart, nextRoute);
const missingStart = loginRoute.indexOf('if (!u)');
assert.ok(missingStart >= 0, 'login route must have an explicit lookup-miss branch');
const missingEnd = loginRoute.indexOf('\n  }', missingStart);
assert.ok(missingEnd > missingStart, 'lookup-miss branch must be bounded');
const missingBranch = loginRoute.slice(missingStart, missingEnd);
const missingVerify = missingBranch.indexOf('verifyPassword(password, null)');
const missingReject = missingBranch.indexOf("return c.json({ error: 'invalid credentials' }, 401)");
assert.ok(missingVerify >= 0, 'lookup miss must perform dummy password verification');
assert.ok(missingReject > missingVerify, 'lookup miss must verify before returning 401');

const script = `
import assert from 'node:assert';
import { hashPassword, verifyPassword } from './server/auth.mjs';

const stored = hashPassword('correct-horse');
assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/);
assert.equal(verifyPassword('correct-horse', stored), true);
assert.equal(verifyPassword('wrong', stored), false);
assert.equal(verifyPassword(['correct-horse'], stored), false, 'array must not coerce to a real password');

// Missing/malformed storage is the lookup-miss primitive boundary. For string
// passwords it must fail closed after dummy scrypt work without throwing.
assert.equal(verifyPassword('wrong', null), false);
assert.equal(verifyPassword('wrong', ''), false);

// Non-string bodies must not throw from scryptSync and must never authenticate.
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

console.log('✓ auth password boundary tests passed');
`;

const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
  cwd: process.cwd(),
  env: { ...process.env, SCOPEWEAVE_JWT_SECRET: SECRET },
  encoding: 'utf8',
});

assert.equal(result.status, 0, result.stderr || result.stdout);
process.stdout.write(result.stdout);
