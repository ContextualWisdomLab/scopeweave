import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_DEV = '1';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.OIDC_ISSUER = 'https://issuer.example/tenant';
process.env.OIDC_CLIENT_ID = 'scopeweave-client';
process.env.OIDC_CLIENT_SECRET = 'scopeweave-secret';
process.env.OIDC_REDIRECT_URI = 'https://scopeweave.example/api/auth/oidc/callback';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'metadata-key', use: 'sig', alg: 'RS256' };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
let issuedIdToken = '';

function signedIdentity(nonce, email = 'sso.user@example.com') {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: publicJwk.kid });
  const payload = encode({
    iss: process.env.OIDC_ISSUER,
    aud: process.env.OIDC_CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce,
    sub: 'subject-1',
    email_verified: true,
    email,
  });
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target === 'https://issuer.example/tenant/.well-known/openid-configuration') {
    return Response.json({
      issuer: process.env.OIDC_ISSUER,
      authorization_endpoint: 'https://login.example/oauth2/v2/authorize',
      token_endpoint: 'https://tokens.example/oauth2/v2/token',
      jwks_uri: 'https://keys.example/oidc/jwks.json',
    });
  }
  if (target === 'https://tokens.example/oauth2/v2/token') {
    return Response.json({ id_token: issuedIdToken });
  }
  if (target === 'https://keys.example/oidc/jwks.json') return Response.json({ keys: [publicJwk] });
  throw new Error(`unexpected OIDC fetch: ${target}`);
};

const { app } = await import('../../server/application_routes.mjs?provider-metadata=1');

async function begin() {
  const response = await app.request('https://scopeweave.example/api/auth/oidc/start');
  assert.equal(response.status, 302, 'complete production OIDC remains active even in development mode');
  const authorization = new URL(response.headers.get('location'));
  assert.equal(authorization.origin, 'https://login.example');
  assert.equal(authorization.pathname, '/oauth2/v2/authorize', 'authorization endpoint comes from validated discovery metadata');
  return { state: authorization.searchParams.get('state'), nonce: authorization.searchParams.get('nonce') };
}

async function metrics() {
  const response = await app.request('https://scopeweave.example/api/metrics');
  assert.equal(response.status, 200);
  return response.json();
}

assert.equal((await metrics()).signups, 0);
let flow = await begin();
issuedIdToken = signedIdentity(flow.nonce);
let response = await app.request(`https://scopeweave.example/api/auth/oidc/callback?state=${encodeURIComponent(flow.state)}&code=first-code`);
assert.equal(response.status, 302, 'token exchange uses the discovered token endpoint and accepts the signed identity');
assert.equal((await metrics()).signups, 1, 'creating an OIDC-backed account increments the same signup metric as password signup');

flow = await begin();
issuedIdToken = signedIdentity(flow.nonce);
response = await app.request(`https://scopeweave.example/api/auth/oidc/callback?state=${encodeURIComponent(flow.state)}&code=second-code`);
assert.equal(response.status, 302);
assert.equal((await metrics()).signups, 1, 'reusing an existing OIDC account does not double-count signup');

console.log('OIDC provider metadata and signup accounting contract passed');
