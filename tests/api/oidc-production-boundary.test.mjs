import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

process.env.SCOPEWEAVE_DB = ':memory:';
delete process.env.SCOPEWEAVE_DEV;
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_ID;
delete process.env.OIDC_CLIENT_SECRET;
delete process.env.OIDC_REDIRECT_URI;
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.STRIPE_SECRET_KEY = 'sk_test_scopeweave_oidc_boundary';
process.env.STRIPE_PRICE_ID = 'price_scopeweave_oidc_boundary';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_oidc_boundary_secret';

const { app } = await import('../../server/app.mjs?oidc-production-boundary=1');
const { app: applicationRoutes } = await import('../../server/application_routes.mjs?oidc-shared-boundary=1');
const { app: internalCoreRoutes } = await import('../../server/application_routes_core.mjs?oidc-internal-boundary=1');

let response = await app.request('https://scopeweave.example/api/auth/oidc/start?email=victim@example.com');
assert.equal(response.status, 404, 'missing production OIDC configuration fails closed');
assert.equal(response.headers.get('location'), null, 'production never redirects into the built-in mock IdP');
assert.deepEqual(await response.json(), { error: 'sso not configured' });

response = await app.request(
  'https://scopeweave.example/api/auth/oidc/mock/authorize?state=attacker&email=victim@example.com&redirect_uri=https%3A%2F%2Fscopeweave.example%2Fapi%2Fauth%2Foidc%2Fcallback',
);
assert.equal(response.status, 404, 'built-in mock authorize endpoint is unreachable outside explicit development mode');
assert.equal(response.headers.get('location'), null, 'mock endpoint cannot mint a production callback code');
assert.deepEqual(await response.json(), { error: 'sso not configured' });

response = await applicationRoutes.request('https://scopeweave.example/api/auth/oidc/start?email=victim@example.com');
assert.equal(response.status, 404, 'shared route graph also fails closed when production OIDC is unconfigured');
assert.equal(response.headers.get('location'), null, 'shared route graph never redirects into the built-in mock IdP');
assert.deepEqual(await response.json(), { error: 'sso not configured' });

response = await applicationRoutes.request(
  'https://scopeweave.example/api/auth/oidc/mock/authorize?state=attacker&email=victim@example.com&redirect_uri=https%3A%2F%2Fscopeweave.example%2Fapi%2Fauth%2Foidc%2Fcallback',
);
assert.equal(response.status, 404, 'shared route graph keeps the mock authorize endpoint closed outside explicit development mode');
assert.equal(response.headers.get('location'), null, 'shared route graph cannot mint a production callback code');
assert.deepEqual(await response.json(), { error: 'sso not configured' });

response = await internalCoreRoutes.request('https://scopeweave.example/api/auth/oidc/start?email=victim@example.com');
assert.equal(response.status, 404, 'internal core graph fails closed rather than enabling mock OIDC when production configuration is absent');
assert.equal(response.headers.get('location'), null, 'internal core graph never redirects into the mock IdP without explicit development mode');
assert.deepEqual(await response.json(), { error: 'sso not configured' });

response = await internalCoreRoutes.request(
  'https://scopeweave.example/api/auth/oidc/mock/authorize?state=attacker&email=victim@example.com&redirect_uri=https%3A%2F%2Fscopeweave.example%2Fapi%2Fauth%2Foidc%2Fcallback',
);
assert.equal(response.status, 404, 'internal core mock authorize stays disabled outside explicit development mode');
assert.equal(response.headers.get('location'), null, 'internal core cannot mint a production callback code');
assert.deepEqual(await response.json(), { error: 'mock disabled' });

const productionIdentityRegression = String.raw`
  import assert from 'node:assert/strict';
  import { generateKeyPairSync, sign } from 'node:crypto';

  process.env.SCOPEWEAVE_DB = ':memory:';
  delete process.env.SCOPEWEAVE_DEV;
  process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.STRIPE_SECRET_KEY = 'sk_test_scopeweave_oidc_signature';
  process.env.STRIPE_PRICE_ID = 'price_scopeweave_oidc_signature';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scopeweave_oidc_signature_secret';
  process.env.OIDC_ISSUER = 'https://issuer.example';
  process.env.OIDC_CLIENT_ID = 'scopeweave-client';
  process.env.OIDC_CLIENT_SECRET = 'scopeweave-secret';
  process.env.OIDC_REDIRECT_URI = 'https://scopeweave.example/api/auth/oidc/callback';

  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'issuer-signing-key',
    use: 'sig',
    alg: 'RS256',
  };
  let issuedIdToken = '';

  const signIdToken = (claims, header = { alg: 'RS256', typ: 'JWT', kid: publicJwk.kid }) => {
    const protectedHeader = encode(header);
    const payload = encode(claims);
    const signingInput = protectedHeader + '.' + payload;
    const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
    return signingInput + '.' + signature;
  };

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target === 'https://issuer.example/token') {
      return new Response(JSON.stringify({ id_token: issuedIdToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (target === 'https://issuer.example/.well-known/openid-configuration') {
      return new Response(JSON.stringify({
        issuer: process.env.OIDC_ISSUER,
        jwks_uri: 'https://issuer.example/jwks',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target === 'https://issuer.example/jwks') {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('unexpected OIDC fetch: ' + target);
  };

  const { app: configuredRoutes } = await import('./server/application_routes.mjs?oidc-production-token-regression=1');
  const begin = async () => {
    const start = await configuredRoutes.request('https://scopeweave.example/api/auth/oidc/start');
    assert.equal(start.status, 302, 'configured OIDC starts the authorization-code flow');
    const authorization = new URL(start.headers.get('location'));
    assert.equal(authorization.origin, 'https://issuer.example');
    assert.equal(authorization.pathname, '/authorize');
    assert.equal(authorization.searchParams.get('client_id'), process.env.OIDC_CLIENT_ID);
    assert.equal(authorization.searchParams.get('response_type'), 'code');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    const state = authorization.searchParams.get('state');
    const nonce = authorization.searchParams.get('nonce');
    assert.ok(state, 'authorization request carries a server-generated state');
    assert.ok(nonce, 'authorization request binds the returned ID token with a nonce');
    return { state, nonce };
  };

  const callback = async (state, code) => configuredRoutes.request(
    'https://scopeweave.example/api/auth/oidc/callback?state=' + encodeURIComponent(state) + '&code=' + encodeURIComponent(code),
  );

  const realDateNow = Date.now;
  let controlledNow = realDateNow();
  Date.now = () => controlledNow;
  const abandonedStates = [];
  for (let index = 0; index < 1024; index += 1) {
    abandonedStates.push(await begin());
  }
  let result = await configuredRoutes.request('https://scopeweave.example/api/auth/oidc/start');
  assert.equal(result.status, 503, 'OIDC authorization state storage fails closed at its bounded capacity');
  assert.equal(result.headers.get('cache-control'), 'no-store', 'OIDC saturation response is never cached');
  assert.deepEqual(await result.json(), { error: 'sso temporarily unavailable' });
  controlledNow += 5 * 60 * 1000 + 1;
  const afterExpiry = await begin();
  Date.now = realDateNow;
  result = await callback(afterExpiry.state, 'discard-expired-capacity-probe');
  assert.equal(result.status, 400, 'a capacity probe can be consumed without minting a session');

  const forged = await begin();
  issuedIdToken = [
    encode({ alg: 'none', typ: 'JWT' }),
    encode({
      iss: process.env.OIDC_ISSUER,
      aud: process.env.OIDC_CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: forged.nonce,
      sub: 'attacker-subject',
      email_verified: true,
      email: 'attacker-chosen@example.com',
    }),
    '',
  ].join('.');
  result = await callback(forged.state, 'attacker-code');
  assert.equal(result.status, 400, 'an unsigned identity token must never mint a ScopeWeave session');
  assert.equal(result.headers.get('location'), null, 'rejected identity tokens never return an application session fragment');

  result = await configuredRoutes.request(
    'https://scopeweave.example/api/auth/oidc/callback?state=unknown&code=attacker-code',
  );
  assert.equal(result.status, 400, 'unknown authorization state fails closed before token exchange');

  const valid = await begin();
  const now = Math.floor(Date.now() / 1000);
  issuedIdToken = signIdToken({
    iss: process.env.OIDC_ISSUER,
    aud: process.env.OIDC_CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce: valid.nonce,
    sub: 'verified-subject',
    email_verified: true,
    email: 'verified@example.com',
  });
  result = await callback(valid.state, 'valid-code');
  assert.equal(result.status, 302, 'a valid issuer-signed ID token completes the production OIDC flow');
  assert.match(result.headers.get('location') || '', /^\/#token=/, 'successful OIDC returns only the ScopeWeave session in a URL fragment');

  const replay = await callback(valid.state, 'replayed-code');
  assert.equal(replay.status, 400, 'OIDC state is single-use after a successful callback');

  const wrongAudience = await begin();
  issuedIdToken = signIdToken({
    iss: process.env.OIDC_ISSUER,
    aud: 'different-client',
    exp: now + 300,
    iat: now,
    nonce: wrongAudience.nonce,
    sub: 'verified-subject',
    email_verified: true,
    email: 'verified@example.com',
  });
  result = await callback(wrongAudience.state, 'wrong-audience-code');
  assert.equal(result.status, 400, 'issuer-signed tokens for another audience are rejected');

  const unverifiedEmail = await begin();
  issuedIdToken = signIdToken({
    iss: process.env.OIDC_ISSUER,
    aud: process.env.OIDC_CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce: unverifiedEmail.nonce,
    sub: 'verified-subject',
    email_verified: false,
    email: 'victim@example.com',
  });
  result = await callback(unverifiedEmail.state, 'unverified-email-code');
  assert.equal(result.status, 400, 'unverified email claims cannot link or create a ScopeWeave account');
`;

const productionIdentityResult = spawnSync(
  process.execPath,
  ['--input-type=module', '--eval', productionIdentityRegression],
  { cwd: process.cwd(), encoding: 'utf8' },
);
assert.equal(
  productionIdentityResult.status,
  0,
  `configured production OIDC must authenticate the IdP before trusting identity claims\nstdout:\n${productionIdentityResult.stdout}\nstderr:\n${productionIdentityResult.stderr}`,
);

console.log('OIDC production fail-closed regression passed');
