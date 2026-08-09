process.env.SCOPEWEAVE_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-to-be-secure';
process.env.SCOPEWEAVE_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-to-be-secure';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { app } from '../../server/app.mjs';
import { db } from '../../server/db.mjs';

const port = 40003; // Random port for test
const server = serve({ fetch: app.fetch, port });

async function req(path, opts = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, opts);
}

// Ensure the url-token endpoint works and tokens can be revoked
async function runTests() {
  const testEmail = `test_url_token_${Date.now()}@example.com`;
  try {
    // 1. Signup a user to get a token
    const signupRes = await req('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: 'password123', name: 'Tester' }),
    });
    const signupData = await signupRes.json();
    const token = signupData.token;

    // 2. Fetch url-token
    const urlTokenRes = await req('/api/auth/url-token', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(urlTokenRes.status, 200, 'Should return 200 OK');
    const urlTokenData = await urlTokenRes.json();
    assert.ok(urlTokenData.urlToken, 'Should return a short-lived urlToken');

    // 3. Test that the url-token is valid
    const meRes = await req('/api/me', {
      headers: { authorization: `Bearer ${urlTokenData.urlToken}` },
    });
    assert.equal(meRes.status, 200, 'urlToken should act as a valid JWT');

    // 4. Test session revocation
    await req('/api/auth/logout-all', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    // 5. url-token should now be invalid
    const meResAfterRevoke = await req('/api/me', {
      headers: { authorization: `Bearer ${urlTokenData.urlToken}` },
    });
    assert.equal(meResAfterRevoke.status, 401, 'urlToken should be revoked when token_version is incremented');

    console.log('✓ url-token session revocation tests passed');
  } finally {
    server.close();
    try {
      const u = db.prepare('SELECT id FROM users WHERE email = ?').get(testEmail);
      if (u) {
        db.prepare('DELETE FROM orgs WHERE owner_id = ?').run(u.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      }
    } catch {}
  }
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
