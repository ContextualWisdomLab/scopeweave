import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_DEV = '1';
process.env.OIDC_ISSUER = 'http://127.0.0.1:19101';
process.env.OIDC_CLIENT_ID = 'scopeweave-email-verification-test';
process.env.OIDC_CLIENT_SECRET = 'scopeweave-secret';
process.env.OIDC_REDIRECT_URI = 'http://localhost/api/auth/oidc/callback';

const issuer = process.env.OIDC_ISSUER;
const clientId = process.env.OIDC_CLIENT_ID;
const authorizationEndpoint = 'http://127.0.0.1:19102/oauth2/authorize';
const tokenEndpoint = 'http://127.0.0.1:19103/oauth2/token';
const jwksEndpoint = 'http://127.0.0.1:19104/jwks';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = {
  ...publicKey.export({ format: 'jwk' }),
  alg: 'RS256',
  kid: 'scopeweave-email-verification-key',
  use: 'sig',
};
let expectedNonce = null;
const originalFetch = globalThis.fetch;

const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signIdToken = (claims) => {
  const header = encoded({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' });
  const payload = encoded(claims);
  const input = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256')
    .update(input)
    .end()
    .sign(privateKey)
    .toString('base64url');
  return `${input}.${signature}`;
};

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (request.url === `${issuer}/.well-known/openid-configuration`) {
    return Response.json({
      issuer,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      jwks_uri: jwksEndpoint,
      id_token_signing_alg_values_supported: ['RS256'],
    });
  }
  if (request.url === jwksEndpoint) {
    return Response.json({ keys: [publicJwk] });
  }
  if (request.url !== tokenEndpoint) {
    throw new Error(`unexpected outbound fetch: ${request.url}`);
  }
  const form = new URLSearchParams(await request.clone().text());
  const code = form.get('code');
  const now = Math.floor(Date.now() / 1000);
  const emailVerified = code === 'verified-email-code';
  return Response.json({
    id_token: signIdToken({
      iss: issuer,
      aud: clientId,
      sub: `oidc-subject-${emailVerified ? 'verified' : 'unverified'}`,
      email: `${emailVerified ? 'verified' : 'unverified'}@scopeweave.test`,
      email_verified: emailVerified,
      nonce: expectedNonce,
      iat: now,
      exp: now + 300,
    }),
  });
};

try {
  const { app } = await import('../../server/app.mjs');

  const callback = async (code) => {
    const start = await app.request('/api/auth/oidc/start');
    assert.equal(start.status, 302, 'OIDC authorization flow starts');
    const authorization = new URL(start.headers.get('location'));
    expectedNonce = authorization.searchParams.get('nonce');
    const state = authorization.searchParams.get('state');
    assert.ok(expectedNonce, 'authorization redirect binds a nonce');
    assert.ok(state, 'authorization redirect binds a state');
    return app.request(
      `/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    );
  };

  const verified = await callback('verified-email-code');
  assert.equal(
    verified.status,
    302,
    'an ID token with a provider-verified email can create the federated session',
  );

  const unverified = await callback('unverified-email-code');
  assert.equal(
    unverified.status,
    400,
    'an ID token with email_verified=false must not be trusted to create or link an account by email',
  );
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.SCOPEWEAVE_DEV;
}

console.log('OIDC verified-email account-linking regression passed');
