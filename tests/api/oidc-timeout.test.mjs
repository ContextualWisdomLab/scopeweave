import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';

process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_DEV = '1';
process.env.OIDC_ISSUER = 'http://127.0.0.1:19001';
process.env.OIDC_CLIENT_ID = 'scopeweave-test';
process.env.OIDC_CLIENT_SECRET = 'scopeweave-secret';
process.env.OIDC_REDIRECT_URI = 'http://localhost/api/auth/oidc/callback';

const issuer = process.env.OIDC_ISSUER;
const clientId = process.env.OIDC_CLIENT_ID;
const authorizationEndpoint = 'http://127.0.0.1:19002/oauth2/authorize';
const tokenEndpoint = 'http://127.0.0.1:19003/oauth2/token';
const jwksEndpoint = 'http://127.0.0.1:19004/jwks';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = {
  ...publicKey.export({ format: 'jwk' }),
  alg: 'RS256',
  kid: 'scopeweave-test-key-1',
  use: 'sig',
};
const signingJwks = Array.from({ length: 9 }, (_, index) => ({
  ...publicJwk,
  kid: `scopeweave-test-key-${index + 1}`,
}));
const expectedNonceByCode = new Map();
let discoveryMode = 'private-metadata';
let observedTimeout = null;
let callbackAbortController = null;
let observedUpstreamAbort = null;
let jwksFetches = 0;
let exactExpiryTokenExchanges = 0;
const originalTimeout = AbortSignal.timeout;
const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signIdToken = (claims, kid = publicJwk.kid) => {
  const header = encoded({ alg: 'RS256', kid, typ: 'JWT' });
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
    if (discoveryMode === 'private-metadata') {
      return Response.json({
        issuer,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: 'https://127.0.0.1/internal-token',
        jwks_uri: 'https://[::1]/internal-jwks',
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    return Response.json({
      issuer,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      jwks_uri: jwksEndpoint,
      id_token_signing_alg_values_supported: ['RS256'],
    });
  }
  if (url === jwksEndpoint) {
    jwksFetches += 1;
    assert.equal(
      request.redirect,
      'error',
      'OIDC JWKS retrieval must reject redirects before trusting signing-key bytes',
    );
    return Response.json({ keys: signingJwks });
  }
  if (url !== tokenEndpoint) {
    throw new Error(`unexpected outbound fetch: ${url}`);
  }
  assert.equal(
    request.redirect,
    'error',
    'OIDC token exchange must not forward authorization code or client credentials across redirects',
  );

  const form = new URLSearchParams(await request.clone().text());
  const code = form.get('code');
  if (code === 'exact-expiry-code') exactExpiryTokenExchanges += 1;
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

  if (code === 'valid-code' || code === 'valid-code-cache' || code === 'exact-expiry-code') {
    return Response.json({ id_token: signIdToken(baseClaims) });
  }
  const signingKeyMatch = /^valid-code-key-(\d+)$/.exec(code || '');
  if (signingKeyMatch) {
    const keyIndex = Number(signingKeyMatch[1]);
    if (keyIndex >= 1 && keyIndex <= signingJwks.length) {
      return Response.json({
        id_token: signIdToken(baseClaims, signingJwks[keyIndex - 1].kid),
      });
    }
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
  if (code === 'future-not-before-code') {
    return Response.json({
      id_token: signIdToken({
        ...baseClaims,
        nbf: now + 120,
      }),
    });
  }
  if (code === 'cancelled-code') {
    callbackAbortController.abort();
    observedUpstreamAbort = request.signal.aborted;
    throw new Error('simulated cancelled identity-provider request');
  }
  throw new Error(`unexpected authorization code: ${code}`);
};

try {
  const { app } = await import('../../server/app.mjs');

  const unsafeMetadata = await app.request('/api/auth/oidc/start');
  assert.equal(
    unsafeMetadata.status,
    502,
    'OIDC discovery metadata cannot redirect server-side token or JWKS requests to private HTTPS addresses',
  );
  discoveryMode = 'valid';

  const startFlow = async (code) => {
    const start = await app.request('/api/auth/oidc/start');
    assert.equal(start.status, 302, 'OIDC authorization flow starts');
    const location = start.headers.get('location');
    assert.ok(location, 'authorization redirect is present');
    const authorization = new URL(location);
    assert.equal(
      `${authorization.origin}${authorization.pathname}`,
      authorizationEndpoint,
      'OIDC authorization uses the provider-discovered authorization endpoint rather than guessing an issuer-relative path',
    );
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
  assert.equal(jwksFetches, 1, 'first verified login retrieves signing-key evidence once');

  const cachedKeyLogin = await callback('valid-code-cache');
  assert.equal(cachedKeyLogin.status, 302, 'a second correctly signed login remains valid');
  assert.equal(
    jwksFetches,
    1,
    'repeated logins with the same signing key reuse bounded JWKS evidence instead of amplifying provider traffic',
  );

  const secondKeyLogin = await callback('valid-code-key-2');
  assert.equal(secondKeyLogin.status, 302, 'a concurrently published second signing key is accepted');
  assert.equal(jwksFetches, 2, 'a new kid requires one bounded JWKS refresh');

  const firstKeyAgain = await callback('valid-code-key-1');
  assert.equal(firstKeyAgain.status, 302, 'the first signing key remains usable during provider key overlap');
  assert.equal(
    jwksFetches,
    2,
    'alternating between two active kids reuses per-kid signing evidence instead of refetching JWKS',
  );

  for (let keyIndex = 3; keyIndex <= signingJwks.length; keyIndex += 1) {
    const rotated = await callback(`valid-code-key-${keyIndex}`);
    assert.equal(rotated.status, 302, `signing key ${keyIndex} is accepted during bounded rotation`);
  }
  assert.equal(
    jwksFetches,
    signingJwks.length,
    'each previously unseen kid causes at most one JWKS refresh while the cache fills',
  );

  const evictedFirstKey = await callback('valid-code-key-1');
  assert.equal(evictedFirstKey.status, 302, 'an evicted signing key can be revalidated from current JWKS');
  assert.equal(
    jwksFetches,
    signingJwks.length + 1,
    'the fixed-size signing-key cache evicts old evidence instead of growing without bound',
  );

  const forged = await callback('forged-code');
  assert.equal(forged.status, 400, 'a forged ID-token signature is rejected');

  const wrongAudience = await callback('wrong-audience-code');
  assert.equal(wrongAudience.status, 400, 'an ID token for another client is rejected');

  const wrongIssuer = await callback('wrong-issuer-code');
  assert.equal(wrongIssuer.status, 400, 'an ID token from another issuer is rejected');

  const wrongNonce = await callback('wrong-nonce-code');
  assert.equal(wrongNonce.status, 400, 'an ID token from another authorization flow is rejected');

  const futureNotBefore = await callback('future-not-before-code');
  assert.equal(
    futureNotBefore.status,
    400,
    'a signed ID token must not be accepted before its nbf time, beyond the allowed clock skew',
  );

  const cancelledState = await startFlow('cancelled-code');
  callbackAbortController = new AbortController();
  const cancelled = await app.request(new Request(
    `http://localhost/api/auth/oidc/callback?state=${encodeURIComponent(cancelledState)}&code=cancelled-code`,
    { signal: callbackAbortController.signal },
  ));
  assert.equal(cancelled.status, 400, 'an upstream-cancelled provider exchange does not create a session');
  assert.equal(
    observedUpstreamAbort,
    true,
    'OIDC token exchange preserves callback cancellation while retaining its timeout budget',
  );

  const anchoredNow = originalDateNow();
  let exactExpiryState;
  try {
    // Keep the historical core OIDC state valid one second longer than the
    // facade nonce. This isolates the facade boundary: on the vulnerable
    // predecessor, equality at the facade expiry reaches the provider and
    // succeeds; on the fixed code it is rejected before any token exchange.
    const startMoments = [
      anchoredNow,
      anchoredNow + 1000,
      anchoredNow,
      anchoredNow,
    ];
    let startMomentIndex = 0;
    Date.now = () => startMoments[Math.min(startMomentIndex++, startMoments.length - 1)];
    exactExpiryState = await startFlow('exact-expiry-code');
    Date.now = () => anchoredNow + (5 * 60 * 1000);
    const exactExpiry = await app.request(
      `/api/auth/oidc/callback?state=${encodeURIComponent(exactExpiryState)}&code=exact-expiry-code`,
    );
    assert.equal(
      exactExpiry.status,
      400,
      'the facade OIDC binding is unusable at its exact configured expiration instant',
    );
    assert.equal(
      exactExpiryTokenExchanges,
      0,
      'an exact-expired facade binding is rejected before any provider token exchange',
    );
  } finally {
    Date.now = originalDateNow;
  }

  for (let index = 0; index < 256; index += 1) {
    const pending = await app.request('/api/auth/oidc/start');
    assert.equal(
      pending.status,
      302,
      'OIDC state capacity must admit flows until the bounded in-memory state budget is full',
    );
  }
  const saturated = await app.request('/api/auth/oidc/start');
  assert.equal(
    saturated.status,
    503,
    'OIDC state capacity must fail closed instead of allowing unbounded in-memory growth',
  );
  assert.deepEqual(
    await saturated.json(),
    { error: 'OIDC temporarily unavailable' },
    'capacity exhaustion returns a stable non-secret degraded-mode response',
  );
} finally {
  Date.now = originalDateNow;
  AbortSignal.timeout = originalTimeout;
  globalThis.fetch = originalFetch;
  delete process.env.SCOPEWEAVE_DEV;
}

console.log('oidc discovery, private-endpoint, validation, not-before, cancellation, inclusive facade expiry, redirect, timeout, bounded per-kid JWKS reuse, and state-capacity regression passed');