import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const SECRET = '0123456789abcdef0123456789abcdef';
const appSource = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf-8');

assert.ok(
  appSource.includes("const DUMMY_HASH = hashPassword('dummy');"),
  'login timing mitigation must keep a startup dummy password hash',
);

process.env.SCOPEWEAVE_JWT_SECRET = SECRET;
process.env.SCOPEWEAVE_DB = ':memory:';

const originalScryptSync = crypto.scryptSync;
const scryptCalls = [];
crypto.scryptSync = (password, salt, keylen, ...rest) => {
  scryptCalls.push({ salt: String(salt), keylen });
  return originalScryptSync(password, salt, keylen, ...rest);
};
syncBuiltinESMExports();

try {
  const { app } = await import('../../server/app.mjs');

  assert.ok(scryptCalls.length >= 1, 'app startup must derive the dummy password hash');
  const dummySalt = scryptCalls.at(-1).salt;
  scryptCalls.length = 0;

  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'missing-user@example.invalid',
      password: 'definitely-wrong-password',
    }),
  });

  assert.equal(response.status, 401, 'unknown user must fail authentication');
  assert.equal(
    scryptCalls.length,
    1,
    'unknown-user login must still execute one password derivation instead of returning early',
  );
  assert.equal(
    scryptCalls[0].salt,
    dummySalt,
    'unknown-user login must verify against the startup dummy hash',
  );
  assert.equal(scryptCalls[0].keylen, 64, 'dummy verification must use the production scrypt output size');
} finally {
  crypto.scryptSync = originalScryptSync;
  syncBuiltinESMExports();
}

console.log('✓ unknown-user login executes the dummy scrypt verification path');
