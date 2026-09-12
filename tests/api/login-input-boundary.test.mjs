process.env.SCOPEWEAVE_JWT_SECRET = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { db } from '../../server/db.mjs';

test('login string coercion contract', async () => {
  const email = `test-${randomBytes(4).toString('hex')}@example.com`;
  db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)').run(email, 'salt:hash', 'Test User');

  const { app } = await import('../../server/app.mjs');

  // Non-string email object
  const res1 = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: { $gt: '' }, password: 'password123' })
  });
  assert.strictEqual(res1.status, 401, 'object email must fail through the normal login boundary');

  // String email but non-string password
  const res2 = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: { p: 1 } })
  });
  assert.strictEqual(res2.status, 401, 'object password must fail through the normal login boundary');
});

function test(name, fn) {
  fn().catch(e => { console.error(e); process.exit(1); });
}
