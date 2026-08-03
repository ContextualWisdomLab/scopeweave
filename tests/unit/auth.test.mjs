import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../server/auth.mjs';

// ---- verifyPassword ------------------------------------------------------

// 1. Happy path: generate a real hash and verify it.
const validPassword = 'super-secret-password';
const storedHash = hashPassword(validPassword);

assert.equal(verifyPassword(validPassword, storedHash), true, 'Valid password should verify successfully');

// 2. Invalid password: wrong password with valid hash.
assert.equal(verifyPassword('wrong-password', storedHash), false, 'Wrong password should fail verification');

// 3. Malformed hashes: gracefully handle bad stored data.
assert.equal(verifyPassword(validPassword, ''), false, 'Empty stored string should fail');
assert.equal(verifyPassword(validPassword, null), false, 'Null stored string should fail');
assert.equal(verifyPassword(validPassword, undefined), false, 'Undefined stored string should fail');
assert.equal(verifyPassword(validPassword, 'no-colon-here'), false, 'Stored string without colon should fail');
assert.equal(verifyPassword(validPassword, 'salt-only:'), false, 'Stored string with empty hash should fail');
assert.equal(verifyPassword(validPassword, ':hash-only'), false, 'Stored string with empty salt should fail');
assert.equal(verifyPassword(validPassword, ':'), false, 'Stored string with only colon should fail');

// 4. Different stored lengths or formats but valid syntax.
// Even if hash lengths do not match expected, timingSafeEqual requires equal lengths.
// The code uses Buffer.from(hash, 'hex'), so valid hex chars are expected, but the length comparison is what safeguards against throwing if scrypt output and known hash differ in length.
const fakeSalt = '1234abcd';
const fakeHashDifferentLength = 'deadbeef';
assert.equal(verifyPassword(validPassword, `${fakeSalt}:${fakeHashDifferentLength}`), false, 'Hash of different length should fail gracefully');

console.log('✓ auth (password verification) unit tests passed');
