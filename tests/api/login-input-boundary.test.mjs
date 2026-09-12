process.env.SCOPEWEAVE_JWT_SECRET = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { db } from '../../server/db.mjs';

async function expectGenericLoginFailure(app, body, label) {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.strictEqual(res.status, 401, `${label}: status`);
  assert.deepStrictEqual(await res.json(), { error: 'invalid credentials' }, `${label}: body`);
}

test('login rejects structured credentials through the generic failure boundary', async () => {
  const email = `test-${randomBytes(4).toString('hex')}@example.com`;
  db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)').run(email, 'salt:hash', 'Test User');

  const { app } = await import('../../server/app.mjs');

  await expectGenericLoginFailure(app, { email: { $gt: '' }, password: 'password123' }, 'object email');
  await expectGenericLoginFailure(app, { email: ['user@example.com'], password: 'password123' }, 'array email');
  await expectGenericLoginFailure(app, { email, password: { p: 1 } }, 'object password');
});

function test(name, fn) {
  fn().catch((error) => {
    console.error(`${name}:`, error);
    process.exitCode = 1;
  });
}
