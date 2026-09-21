// static_coverage_evidence requires this for testing structural performance optimizations that cannot be
// realistically tested through I/O changes (e.g. constant time password comparison where timing attacks
// are what's being prevented).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appPath = fileURLToPath(new URL('../../server/app.mjs', import.meta.url));
const appCode = readFileSync(appPath, 'utf8');

const loginEndpoint = appCode.substring(
  appCode.indexOf("app.post('/api/auth/login'"),
  appCode.indexOf("app.get('/api/me'")
);

assert.ok(
  loginEndpoint.includes("const dummyHash = '0'.repeat(32) + ':' + '0'.repeat(128);") &&
  loginEndpoint.includes("const hashToVerify = u ? u.password_hash : dummyHash;") &&
  loginEndpoint.includes("const isValid = verifyPassword(candidatePassword, hashToVerify);"),
  'Login endpoint must use a dynamic dummy hash and unconditional verifyPassword to prevent user enumeration timing attacks.'
);

console.log('✓ auth timing attack prevention test passed');
