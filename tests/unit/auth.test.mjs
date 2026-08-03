import test from 'node:test';
import assert from 'node:assert';
import { generateApiToken, hashApiToken, hashPassword, verifyPassword, signToken, verifyToken } from '../../server/auth.mjs';

test('JWT signing and verification uses secure secret generation fallback', (t) => {
  // Test valid token creation
  const payload = { user: 'test_user_123' };
  const token = signToken(payload);
  const decoded = verifyToken(token);

  assert.equal(decoded.user, payload.user);
  assert.ok(decoded.iat);
  assert.ok(decoded.exp);
});

test('JWT verification fails for tampered tokens', (t) => {
  const token = signToken({ user: 'test' });
  const [header, body, sig] = token.split('.');

  // Tampered payload
  const tamperedBody = Buffer.from(JSON.stringify({ user: 'admin', iat: 0, exp: 9999999999 })).toString('base64url');
  assert.throws(() => {
    verifyToken(`${header}.${tamperedBody}.${sig}`);
  }, /bad signature/);

  // Malformed token
  assert.throws(() => {
    verifyToken(`malformed`);
  }, /malformed token/);
});

test('Password hashing and verification', (t) => {
  const pw = 'mySuperSecretPassword123!';
  const hashed = hashPassword(pw);

  assert.ok(hashed.includes(':'));

  assert.equal(verifyPassword(pw, hashed), true);
  assert.equal(verifyPassword('wrong', hashed), false);
  assert.equal(verifyPassword(pw, 'invalid:hash'), false);
  assert.equal(verifyPassword(pw, ''), false);
  assert.equal(verifyPassword(pw, null), false);
});

test('API Token generation and hashing', (t) => {
  const token = generateApiToken();
  assert.ok(token.full.startsWith('swk_'));
  assert.equal(token.prefix, token.full.slice(0, 12));
  assert.ok(token.hash);

  assert.equal(hashApiToken(token.full), token.hash);
});
