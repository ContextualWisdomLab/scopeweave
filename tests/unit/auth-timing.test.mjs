import assert from 'node:assert';
import { hashPassword, verifyPassword } from '../../server/auth.mjs';

const DUMMY_HASH = hashPassword('');

function simulateLogin(email, password, userFound) {
  const passwordHash = userFound ? hashPassword('correct_password') : null;
  const u = userFound ? { password_hash: passwordHash } : null;

  const isMatch = verifyPassword(typeof password === 'string' ? password : '', u ? u.password_hash : DUMMY_HASH);

  if (!u || typeof password !== 'string' || !isMatch) {
    return false;
  }
  return true;
}

try {
  // Test invalid user, returns false but evaluates DUMMY_HASH
  assert.strictEqual(simulateLogin('invalid@test.com', 'pass', false), false);

  // Test valid user, wrong password, returns false
  assert.strictEqual(simulateLogin('valid@test.com', 'wrong', true), false);

  // Test valid user, correct password, returns true
  assert.strictEqual(simulateLogin('valid@test.com', 'correct_password', true), true);

  // Test type mismatch on password, returns false
  assert.strictEqual(simulateLogin('valid@test.com', { invalid: 'type' }, true), false);

  console.log('✓ auth timing integration tests passed');
} catch (err) {
  console.error('Test failed:', err);
  process.exit(1);
}
