import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.OIDC_ISSUER = 'https://idp.example.test';
process.env.OIDC_CLIENT_ID = 'scopeweave-test';
process.env.OIDC_CLIENT_SECRET = 'scopeweave-secret';
process.env.OIDC_REDIRECT_URI = 'http://localhost/api/auth/oidc/callback';

const issuer = process.env.OIDC_ISSUER;
const clientId = process.env.OIDC_CLIENT_ID;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = {
  ...publicKey.export({ format: 'jwk' }),
  alg: 'RS256',
  kid: 'scopeweave-test-key',
  use: 'sig',
};
const expectedNonceByCode = new Map();
let observedTimeout = null;
const originalTimeout = AbortSignal.timeout;
const originalFetch = globalThis.fetch;

const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signIdToken = (claims) => {
  const header = encoded({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' });
  const payload = encoded(claims);
  const input = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(input).end().sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
};

AbortSignal.timeout = (milliseconds) => {
  observedTimeout = milliseconds;
  return new AbortController().signal;
};

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = request.url;
  if (url === `${issuer}/.well-known/openid-configuration`) {
    assert.equal(
      request.redirect,
      'error',
      'OIDC discovery must reject redirects instead of following provider-controlled locations',
    );
    return Response.json({
      issuer,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
    });
  }
  if (url === `${issuer}/jwks`) {
    assert.equal(
      request.redirect,
      'error',
      'OIDC JWKS retrieval must reject redirects before trusting signing-key bytes',
    );
    return Response.json({ keys: [publicJwk] });
  }
  if (url !== `${issuer}/token`) {
    throw new Error(`unexpected outbound fetch: ${url}`);
  }
  assert.equal(
    request.redirect,
    'error',
    'OIDC token exchange must not forward authorization code or client credentials across redirects',
  );

  const form = new URLSearchParams(await request.clone().text());
  const code = form.get('code');
  const expectedNonce = expectedNonceByCode.get(code);
  const now = Math.floor(Date.now() / 1000);
  const baseClaims = {
    iss: issuer,
    aud: clientId,
    sub: 'oidc-subject-123',
    email: 'oidc-timeout@scopeweave.test',
    nonce: expectedNonce,
    iat: now,
    exp: now + 300,
  };

  if (code === 'valid-code') {
    return Response.json({ id_token: signIdToken(baseClaims) });
  }
  if (code === 'forged-code') {
    const valid = signIdToken(baseClaims).split('.');
    valid[2] = Buffer.from('forged-signature').toString('base64url');
    return Response.json({ id_token: valid.join('.') });
  }
  if (code === 'wrong-audience-code') {
    return Response.json({ id_token: signIdToken({ ...baseClaims, aud: 'attacker-client' }) });
  }
  if (code === 'wrong-issuer-code') {
    return Response.json({ id_token: signIdToken({ ...baseClaims, iss: 'https://evil.example.test' }) });
  }
  if (code === 'wrong-nonce-code') {
    return Response.json({ id_token: signIdToken({ ...baseClaims, nonce: 'attacker-nonce' }) });
  }
  throw new Error(`unexpected authorization code: ${code}`);
};

try {
  const { app } = await import('../../server/app.mjs');

  const startFlow = async (code) => {
    const start = await app.request('/api/auth/oidc/start');
    assert.equal(start.status, 302, 'OIDC authorization flow starts');
    const location = start.headers.get('location');
    assert.ok(location, 'authorization redirect is present');
    const authorization = new URL(location);
    const state = authorization.searchParams.get('state');
    const nonce = authorization.searchParams.get('nonce');
    assert.ok(state, 'authorization redirect carries state');
    assert.ok(nonce, 'authorization redirect carries an OIDC nonce bound to this flow');
    expectedNonceByCode.set(code, nonce);
    return state;
  };

  const callback = async (code) => {
    const state = await startFlow(code);
    return app.request(
      `/api/auth/oidc/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    );
  };

  const valid = await callback('valid-code');
  assert.equal(valid.status, 302, 'a correctly signed and bound ID token creates the session');
  assert.equal(
    observedTimeout,
    3000,
    'OIDC provider calls use the bounded three-second provider budget',
  );

  const forged = await callback('forged-code');
  assert.equal(forged.status, 400, 'a forged ID-token signature is rejected');

  const wrongAudience = await callback('wrong-audience-code');
  assert.equal(wrongAudience.status, 400, 'an ID token for another client is rejected');

  const wrongIssuer = await callback('wrong-issuer-code');
  assert.equal(wrongIssuer.status, 400, 'an ID token from another issuer is rejected');

  const wrongNonce = await callback('wrong-nonce-code');
  assert.equal(wrongNonce.status, 400, 'an ID token from another authorization flow is rejected');
} finally {
  AbortSignal.timeout = originalTimeout;
  globalThis.fetch = originalFetch;
}

console.log('oidc validation and timeout regression passed');
