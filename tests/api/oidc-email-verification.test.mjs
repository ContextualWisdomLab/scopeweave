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
const primaryEmail = 'verified@scopeweave.test';
const renamedEmail = 'renamed@scopeweave.test';
const primarySubject = 'oidc-subject-verified';
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

const claimCases = {
  'verified-email-code': {
    sub: primarySubject,
    email: primaryEmail,
    email_verified: true,
  },
  'renamed-email-code': {
    sub: primarySubject,
    email: renamedEmail,
    email_verified: true,
  },
  'reassigned-email-code': {
    sub: 'oidc-subject-reassigned',
    email: primaryEmail,
    email_verified: true,
  },
  'unverified-email-code': {
    sub: 'oidc-subject-unverified',
    email: 'unverified@scopeweave.test',
    email_verified: false,
  },
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
  const claimCase = claimCases[code];
  if (!claimCase) throw new Error(`unexpected authorization code: ${code}`);
  const now = Math.floor(Date.now() / 1000);
  return Response.json({
    id_token: signIdToken({
      iss: issuer,
      aud: clientId,
      ...claimCase,
      nonce: expectedNonce,
      iat: now,
      exp: now + 300,
    }),
  });
};

const sessionSubject = (response) => {
  const location = response.headers.get('location') || '';
  const token = location.split('#token=')[1] || '';
  const payload = token.split('.')[1] || '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sub;
};

try {
  const { app } = await import('../../server/app.mjs');
  const { db } = await import('../../server/db.mjs');

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
  const initialUserId = sessionSubject(verified);

  const reassigned = await callback('reassigned-email-code');
  assert.equal(
    reassigned.status,
    409,
    'a different subject cannot take over an existing federated account by reusing its current verified email',
  );

  const renamed = await callback('renamed-email-code');
  assert.equal(
    renamed.status,
    302,
    'the same issuer/subject remains the same local identity after its email claim changes',
  );
  assert.equal(
    sessionSubject(renamed),
    initialUserId,
    'federated identity follows stable issuer/subject rather than a mutable email claim',
  );

  const unverified = await callback('unverified-email-code');
  assert.equal(
    unverified.status,
    400,
    'an ID token with email_verified=false must not be trusted to create or link an account by email',
  );

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    1,
    'email changes and reassignment attempts do not create shadow federated users',
  );
  const identityLinks = db.prepare(
    `SELECT issuer_url AS issuer, subject_identifier AS subject, user_id AS userId
     FROM oidc_identity_links ORDER BY id`,
  ).all();
  assert.deepEqual(
    identityLinks,
    [{ issuer, subject: primarySubject, userId: Number(initialUserId) }],
    'the durable federated identity key is the verified issuer/subject pair',
  );
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.SCOPEWEAVE_DEV;
}

console.log('OIDC stable-subject account-linking regression passed');
