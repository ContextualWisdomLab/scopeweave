import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  sign as signBytes,
} from 'node:crypto';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = 'scopeweave-oidc-route-test-secret-at-least-32-characters';
process.env.OIDC_ISSUER = 'https://identity.example/tenant';
process.env.OIDC_CLIENT_ID = 'scopeweave-client';
process.env.OIDC_CLIENT_SECRET = 'scopeweave-client-secret';
process.env.OIDC_REDIRECT_URI = 'https://scopeweave.example/api/auth/oidc/callback';
delete process.env.SCOPEWEAVE_DEV;

const ISSUER = process.env.OIDC_ISSUER;
const CLIENT_ID = process.env.OIDC_CLIENT_ID;
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'route-key',
  use: 'sig',
  alg: 'RS256',
};
let currentNonce = '';
let tamperSignature = false;

function encoded(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function idToken() {
  const header = encoded({ alg: 'RS256', typ: 'JWT', kid: jwk.kid });
  const claims = encoded({
    iss: ISSUER,
    sub: 'subject-route-42',
    aud: CLIENT_ID,
    exp: NOW_SECONDS + 600,
    iat: NOW_SECONDS - 5,
    nonce: currentNonce,
    email: 'route-owner@example.com',
    email_verified: true,
  });
  const input = `${header}.${claims}`;
  let signature = signBytes('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  if (tamperSignature) signature = `${signature.slice(0, -1)}A`;
  return `${input}.${signature}`;
}

globalThis.fetch = async (url) => {
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return new Response(JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url === `${ISSUER}/token`) {
    return new Response(JSON.stringify({ id_token: idToken() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url === `${ISSUER}/jwks`) {
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unexpected OIDC request: ${url}`);
};

const { app } = await import('../../server/app.mjs');
const { db } = await import('../../server/db.mjs');

async function startAuthorization() {
  const response = await app.request(
    'https://scopeweave.example/api/auth/oidc/start',
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.origin + location.pathname, `${ISSUER}/authorize`);
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  currentNonce = location.searchParams.get('nonce');
  assert.ok(currentNonce);
  return location.searchParams.get('state');
}

{
  const state = await startAuthorization();
  const response = await app.request(
    `https://scopeweave.example/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=route-code-1`,
  );
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/#token=/);
  assert.equal(
    db.prepare('SELECT email FROM users WHERE email = ?').get('route-owner@example.com').email,
    'route-owner@example.com',
  );

  const replay = await app.request(
    `https://scopeweave.example/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=route-code-1`,
  );
  assert.equal(replay.status, 400);
  assert.deepEqual(await replay.json(), { error: 'invalid or expired state' });
}

{
  tamperSignature = true;
  const state = await startAuthorization();
  const response = await app.request(
    `https://scopeweave.example/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=route-code-2`,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'oidc_id_token_signature_invalid',
  });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('route-owner@example.com').count,
    1,
  );
}
