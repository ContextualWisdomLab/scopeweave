import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  sign as signBytes,
} from 'node:crypto';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ISSUER = 'https://identity.example/tenant';
const CLIENT_ID = 'scopeweave-client';
const CLIENT_SECRET = 'scopeweave-client-secret';
const REDIRECT_URI = 'https://scopeweave.example/api/auth/oidc/callback';
const NOW_SECONDS = 1_786_291_200;
const STATE = 'state_abcdefghijklmnopqrstuvwxyz0123456789';
const NONCE = 'nonce_abcdefghijklmnopqrstuvwxyz0123456789';
const CHALLENGE = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const VERIFIER = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-._~';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const PUBLIC_JWK = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'scopeweave-test-key',
  use: 'sig',
  alg: 'RS256',
};

function restoreEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  globalThis.fetch = ORIGINAL_FETCH;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signedIdToken({ claims = {}, header = {}, signingKey = privateKey } = {}) {
  const encodedHeader = encodeJson({
    alg: 'RS256',
    typ: 'JWT',
    kid: PUBLIC_JWK.kid,
    ...header,
  });
  const encodedClaims = encodeJson({
    iss: ISSUER,
    sub: 'subject-42',
    aud: CLIENT_ID,
    exp: NOW_SECONDS + 600,
    iat: NOW_SECONDS - 10,
    nonce: NONCE,
    email: 'Owner@Example.com',
    email_verified: true,
    ...claims,
  });
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = signBytes(
    'RSA-SHA256',
    Buffer.from(signingInput),
    signingKey,
  ).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function freshModule(label) {
  return import(`../../server/oidc.mjs?test=${label}-${Date.now()}-${Math.random()}`);
}

function clearOidcEnvironment() {
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_REDIRECT_URI;
  delete process.env.SCOPEWEAVE_DEV;
}

function configureProduction() {
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.OIDC_REDIRECT_URI = REDIRECT_URI;
  delete process.env.SCOPEWEAVE_DEV;
}

try {
  clearOidcEnvironment();
  const unconfigured = await freshModule('unconfigured');
  assert.equal(unconfigured.oidcMock, false);
  await assert.rejects(
    unconfigured.authorizationUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: CHALLENGE,
    }),
    (error) => error.code === 'oidc_not_configured' && error.statusCode === 503,
  );

  process.env.SCOPEWEAVE_DEV = '1';
  const development = await freshModule('development');
  assert.equal(development.oidcMock, true);
  await assert.rejects(
    development.authorizationUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: CHALLENGE,
    }),
    (error) => error.code === 'oidc_development_route_required',
  );

  configureProduction();
  delete process.env.OIDC_CLIENT_SECRET;
  const incomplete = await freshModule('incomplete');
  await assert.rejects(
    incomplete.authorizationUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: CHALLENGE,
    }),
    (error) => error.code === 'oidc_configuration_incomplete',
  );

  configureProduction();
  process.env.OIDC_ISSUER = 'http://identity.example/tenant';
  const insecure = await freshModule('insecure');
  await assert.rejects(
    insecure.authorizationUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: CHALLENGE,
    }),
    (error) => error.code === 'oidc_issuer_invalid',
  );

  configureProduction();
  const configured = await freshModule('configured');
  let currentToken = signedIdToken();
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === `${ISSUER}/token`) {
      return new Response(JSON.stringify({ id_token: currentToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === `${ISSUER}/jwks`) {
      return new Response(JSON.stringify({ keys: [PUBLIC_JWK] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const authorization = await configured.authorizationUrl({
    state: STATE,
    nonce: NONCE,
    codeChallenge: CHALLENGE,
  });
  const authorizationLocation = new URL(authorization.url);
  assert.equal(authorization.redirectUri, REDIRECT_URI);
  assert.equal(authorizationLocation.origin + authorizationLocation.pathname, `${ISSUER}/authorize`);
  assert.equal(authorizationLocation.searchParams.get('response_type'), 'code');
  assert.equal(authorizationLocation.searchParams.get('scope'), 'openid email profile');
  assert.equal(authorizationLocation.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorizationLocation.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(authorizationLocation.searchParams.get('state'), STATE);
  assert.equal(authorizationLocation.searchParams.get('nonce'), NONCE);
  assert.equal(authorizationLocation.searchParams.get('code_challenge'), CHALLENGE);
  assert.equal(authorizationLocation.searchParams.get('code_challenge_method'), 'S256');

  const identity = await configured.exchangeAuthorizationCode({
    code: 'authorization-code-1',
    codeVerifier: VERIFIER,
    nonce: NONCE,
    redirectUri: REDIRECT_URI,
    nowSeconds: NOW_SECONDS,
  });
  assert.equal(identity.email, 'owner@example.com');
  assert.equal(identity.subject, 'subject-42');
  const tokenCall = calls.find((call) => call.url === `${ISSUER}/token`);
  assert.equal(tokenCall.init.method, 'POST');
  assert.match(tokenCall.init.headers.authorization, /^Basic /);
  assert.ok(tokenCall.init.signal instanceof AbortSignal);
  const tokenBody = new URLSearchParams(tokenCall.init.body);
  assert.equal(tokenBody.get('grant_type'), 'authorization_code');
  assert.equal(tokenBody.get('code'), 'authorization-code-1');
  assert.equal(tokenBody.get('redirect_uri'), REDIRECT_URI);
  assert.equal(tokenBody.get('code_verifier'), VERIFIER);

  assert.deepEqual(
    configured.verifyIdToken({
      idToken: currentToken,
      jwks: { keys: [PUBLIC_JWK] },
      issuer: ISSUER,
      clientId: CLIENT_ID,
      nonce: NONCE,
      nowSeconds: NOW_SECONDS,
    }).email,
    'owner@example.com',
  );

  const invalidClaimCases = [
    ['issuer', { iss: 'https://attacker.example' }, 'oidc_id_token_issuer_invalid'],
    ['audience', { aud: 'another-client' }, 'oidc_id_token_audience_invalid'],
    ['authorized party', { aud: [CLIENT_ID, 'another-client'], azp: 'another-client' }, 'oidc_id_token_authorized_party_invalid'],
    ['expiration', { exp: NOW_SECONDS - 61 }, 'oidc_id_token_expired'],
    ['future issued-at', { iat: NOW_SECONDS + 61 }, 'oidc_id_token_issued_at_invalid'],
    ['not-before', { nbf: NOW_SECONDS + 61 }, 'oidc_id_token_not_before_invalid'],
    ['nonce', { nonce: 'nonce_attacker_abcdefghijklmnopqrstuvwxyz' }, 'oidc_id_token_nonce_invalid'],
    ['subject', { sub: '' }, 'oidc_id_token_subject_invalid'],
    ['email verification', { email_verified: false }, 'oidc_id_token_email_invalid'],
  ];
  for (const [label, claims, code] of invalidClaimCases) {
    assert.throws(
      () => configured.verifyIdToken({
        idToken: signedIdToken({ claims }),
        jwks: { keys: [PUBLIC_JWK] },
        issuer: ISSUER,
        clientId: CLIENT_ID,
        nonce: NONCE,
        nowSeconds: NOW_SECONDS,
      }),
      (error) => error.code === code,
      label,
    );
  }

  const { privateKey: attackerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(
    () => configured.verifyIdToken({
      idToken: signedIdToken({ signingKey: attackerKey }),
      jwks: { keys: [PUBLIC_JWK] },
      issuer: ISSUER,
      clientId: CLIENT_ID,
      nonce: NONCE,
      nowSeconds: NOW_SECONDS,
    }),
    (error) => error.code === 'oidc_id_token_signature_invalid',
  );
  assert.throws(
    () => configured.verifyIdToken({
      idToken: signedIdToken({ header: { alg: 'none' } }),
      jwks: { keys: [PUBLIC_JWK] },
      issuer: ISSUER,
      clientId: CLIENT_ID,
      nonce: NONCE,
      nowSeconds: NOW_SECONDS,
    }),
    (error) => error.code === 'oidc_id_token_algorithm_invalid',
  );
  assert.throws(
    () => configured.verifyIdToken({
      idToken: currentToken,
      jwks: { keys: [] },
      issuer: ISSUER,
      clientId: CLIENT_ID,
      nonce: NONCE,
      nowSeconds: NOW_SECONDS,
    }),
    (error) => error.code === 'oidc_signing_key_not_found',
  );

  await assert.rejects(
    configured.exchangeAuthorizationCode({
      code: 'authorization-code-1',
      codeVerifier: VERIFIER,
      nonce: NONCE,
      redirectUri: 'https://scopeweave.example/incorrect',
      nowSeconds: NOW_SECONDS,
    }),
    (error) => error.code === 'oidc_redirect_uri_mismatch',
  );

  configureProduction();
  const mismatch = await freshModule('issuer-mismatch');
  globalThis.fetch = async () => new Response(JSON.stringify({
    issuer: 'https://attacker.example',
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
  }), { status: 200 });
  await assert.rejects(
    mismatch.authorizationUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: CHALLENGE,
    }),
    (error) => error.code === 'oidc_discovery_issuer_mismatch',
  );
} finally {
  restoreEnvironment();
}

console.log('✓ OIDC production signature verification tests passed');
