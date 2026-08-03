import assert from 'node:assert';
import { generateApiToken, hashApiToken } from '../../server/auth.mjs';
import { createHash } from 'node:crypto';

// ---- generateApiToken ----------------------------------------------------
const tokenData = generateApiToken();
assert.ok(tokenData.full.startsWith('swk_'), 'token starts with swk_ prefix');
// 24 random bytes in base64url is 32 characters, plus 'swk_' makes 36 characters
assert.equal(tokenData.full.length, 36, 'token has the expected length');
assert.equal(tokenData.prefix, tokenData.full.slice(0, 12), 'prefix is exactly the first 12 characters');
assert.equal(tokenData.hash, createHash('sha256').update(tokenData.full).digest('hex'), 'hash is the sha256 hex digest of the full token');

const tokenData2 = generateApiToken();
assert.notEqual(tokenData.full, tokenData2.full, 'subsequent tokens are unique');

// ---- hashApiToken --------------------------------------------------------
assert.equal(hashApiToken(tokenData.full), tokenData.hash, 'hashApiToken matches generateApiToken hash output');
assert.equal(hashApiToken(123), createHash('sha256').update('123').digest('hex'), 'hashApiToken casts numeric input to string');
assert.equal(hashApiToken(undefined), createHash('sha256').update('undefined').digest('hex'), 'hashApiToken handles undefined by stringifying');
