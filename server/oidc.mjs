import {
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

const RAW_ISSUER = String(process.env.OIDC_ISSUER || '').trim();
const CLIENT_ID = String(process.env.OIDC_CLIENT_ID || '').trim();
const CLIENT_SECRET = String(process.env.OIDC_CLIENT_SECRET || '').trim();
const REDIRECT_URI = String(process.env.OIDC_REDIRECT_URI || '').trim();
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_ID_TOKEN_BYTES = 128 * 1024;
const CLOCK_SKEW_SECONDS = 60;
const CACHE_TTL_MS = 5 * 60 * 1000;

export const oidcMock = process.env.SCOPEWEAVE_DEV === '1' && !RAW_ISSUER;

/** Stable, operator-safe failure raised by the OpenID Connect trust boundary. */
export class OidcConfigurationError extends Error {
  /**
   * Create one OIDC error.
   * @param {string} code machine-readable failure code
   * @param {string} message operator-safe detail
   * @param {number} statusCode HTTP status suitable for the relying-party API
   */
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'OidcConfigurationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Return whether an HTTP endpoint is permitted for OIDC transport.
 * @param {URL} url parsed endpoint
 * @returns {boolean}
 */
function isSecureEndpoint(url) {
  return url.protocol === 'https:'
    || (
      url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    );
}

/**
 * Parse and validate one OIDC URL.
 * @param {string} value candidate URL
 * @param {string} code failure-code prefix
 * @param {{allowQuery?: boolean}} options URL policy
 * @returns {URL}
 */
function validatedUrl(value, code, { allowQuery = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OidcConfigurationError(
      `${code}_invalid`,
      `${code} must be a valid absolute URL.`,
      503,
    );
  }
  if (
    !isSecureEndpoint(url)
    || url.username
    || url.password
    || url.hash
    || (!allowQuery && url.search)
  ) {
    throw new OidcConfigurationError(
      `${code}_invalid`,
      `${code} violates the OIDC transport or URL policy.`,
      503,
    );
  }
  return url;
}

/**
 * Resolve explicit development mode or complete production relying-party configuration.
 * @returns {{mock: true} | {mock: false, issuer: string, clientId: string, clientSecret: string, redirectUri: string}}
 */
function oidcConfiguration() {
  if (oidcMock) return { mock: true };
  if (!RAW_ISSUER) {
    throw new OidcConfigurationError(
      'oidc_not_configured',
      'OpenID Connect is unavailable because OIDC_ISSUER is not configured.',
      503,
    );
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    throw new OidcConfigurationError(
      'oidc_configuration_incomplete',
      'OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_REDIRECT_URI are required.',
      503,
    );
  }
  const issuerUrl = validatedUrl(RAW_ISSUER, 'oidc_issuer');
  const redirectUrl = validatedUrl(REDIRECT_URI, 'oidc_redirect_uri', {
    allowQuery: true,
  });
  const issuer = issuerUrl.toString().replace(/\/$/, '');
  return {
    mock: false,
    issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: redirectUrl.toString(),
  };
}

/**
 * Validate one bounded opaque protocol value.
 * @param {unknown} value candidate value
 * @param {string} field field name
 * @param {number} minimumLength minimum accepted length
 * @param {number} maximumLength maximum accepted length
 * @returns {string}
 */
function boundedProtocolValue(value, field, minimumLength, maximumLength) {
  if (
    typeof value !== 'string'
    || value.length < minimumLength
    || value.length > maximumLength
    || !/^[A-Za-z0-9._~-]+$/.test(value)
  ) {
    throw new OidcConfigurationError(
      `oidc_${field}_invalid`,
      `OIDC ${field} is outside the accepted boundary.`,
    );
  }
  return value;
}

/**
 * Fetch one bounded JSON object from the provider.
 * @param {string} url provider endpoint
 * @param {RequestInit} init request options
 * @param {string} failurePrefix failure-code prefix
 * @returns {Promise<Record<string, unknown>>}
 */
async function fetchJson(url, init, failurePrefix) {
  if (typeof globalThis.fetch !== 'function') {
    throw new OidcConfigurationError(
      `${failurePrefix}_transport_unavailable`,
      'OIDC HTTP transport is unavailable.',
      503,
    );
  }
  let response;
  try {
    response = await globalThis.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OidcConfigurationError(
      `${failurePrefix}_unavailable`,
      'The OpenID Provider could not be reached.',
      502,
    );
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new OidcConfigurationError(
      `${failurePrefix}_response_invalid`,
      'The OpenID Provider response could not be read.',
      502,
    );
  }
  if (bytes.length === 0 || bytes.length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new OidcConfigurationError(
      `${failurePrefix}_response_size_invalid`,
      'The OpenID Provider response size is outside the accepted boundary.',
      502,
    );
  }
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new OidcConfigurationError(
      `${failurePrefix}_response_invalid`,
      'The OpenID Provider returned non-JSON data.',
      502,
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new OidcConfigurationError(
      `${failurePrefix}_response_invalid`,
      'The OpenID Provider returned an invalid JSON object.',
      502,
    );
  }
  if (!response.ok) {
    throw new OidcConfigurationError(
      `${failurePrefix}_rejected`,
      `The OpenID Provider rejected the request with HTTP ${response.status}.`,
      502,
    );
  }
  return payload;
}

let discoveryCache = null;
let jwksCache = null;

/**
 * Validate provider metadata and bind it to the configured issuer.
 * @param {Record<string, unknown>} metadata discovery document
 * @param {string} issuer configured issuer
 * @returns {{issuer: string, authorizationEndpoint: string, tokenEndpoint: string, jwksUri: string, tokenAuthMethods: string[]}}
 */
function validatedDiscovery(metadata, issuer) {
  if (metadata.issuer !== issuer) {
    throw new OidcConfigurationError(
      'oidc_discovery_issuer_mismatch',
      'OIDC discovery issuer does not exactly match OIDC_ISSUER.',
      502,
    );
  }
  const authorizationEndpoint = validatedUrl(
    String(metadata.authorization_endpoint || ''),
    'oidc_authorization_endpoint',
    { allowQuery: true },
  ).toString();
  const tokenEndpoint = validatedUrl(
    String(metadata.token_endpoint || ''),
    'oidc_token_endpoint',
    { allowQuery: true },
  ).toString();
  const jwksUri = validatedUrl(
    String(metadata.jwks_uri || ''),
    'oidc_jwks_uri',
    { allowQuery: true },
  ).toString();
  const signingAlgorithms = metadata.id_token_signing_alg_values_supported;
  if (
    Array.isArray(signingAlgorithms)
    && !signingAlgorithms.includes('RS256')
  ) {
    throw new OidcConfigurationError(
      'oidc_rs256_unsupported',
      'The OpenID Provider does not advertise RS256 ID Token signing.',
      502,
    );
  }
  const tokenAuthMethods = Array.isArray(
    metadata.token_endpoint_auth_methods_supported,
  )
    ? metadata.token_endpoint_auth_methods_supported.filter(
      (method) => typeof method === 'string',
    )
    : ['client_secret_basic'];
  if (
    !tokenAuthMethods.includes('client_secret_basic')
    && !tokenAuthMethods.includes('client_secret_post')
  ) {
    throw new OidcConfigurationError(
      'oidc_token_auth_unsupported',
      'The OpenID Provider supports no configured client-secret authentication method.',
      502,
    );
  }
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    tokenAuthMethods,
  };
}

/**
 * Load and cache exact issuer discovery metadata.
 * @param {ReturnType<typeof oidcConfiguration>} configuration production configuration
 * @returns {Promise<ReturnType<typeof validatedDiscovery>>}
 */
async function providerDiscovery(configuration) {
  const now = Date.now();
  if (
    discoveryCache
    && discoveryCache.issuer === configuration.issuer
    && discoveryCache.expiresAt > now
  ) {
    return discoveryCache.value;
  }
  const metadata = await fetchJson(
    `${configuration.issuer}/.well-known/openid-configuration`,
    { headers: { accept: 'application/json' } },
    'oidc_discovery',
  );
  const value = validatedDiscovery(metadata, configuration.issuer);
  discoveryCache = {
    issuer: configuration.issuer,
    expiresAt: now + CACHE_TTL_MS,
    value,
  };
  return value;
}

/**
 * Return a provider authorization URL bound to state, nonce, and S256 PKCE.
 * @param {{state: string, nonce: string, codeChallenge: string}} request authorization request values
 * @returns {Promise<{url: string, redirectUri: string}>}
 */
export async function authorizationUrl({ state, nonce, codeChallenge }) {
  const configuration = oidcConfiguration();
  if (configuration.mock) {
    throw new OidcConfigurationError(
      'oidc_development_route_required',
      'Development OIDC must use the local explicit mock route.',
      500,
    );
  }
  const safeState = boundedProtocolValue(state, 'state', 32, 256);
  const safeNonce = boundedProtocolValue(nonce, 'nonce', 32, 256);
  const safeChallenge = boundedProtocolValue(
    codeChallenge,
    'code_challenge',
    43,
    128,
  );
  const discovery = await providerDiscovery(configuration);
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('client_id', configuration.clientId);
  url.searchParams.set('redirect_uri', configuration.redirectUri);
  url.searchParams.set('state', safeState);
  url.searchParams.set('nonce', safeNonce);
  url.searchParams.set('code_challenge', safeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), redirectUri: configuration.redirectUri };
}

/**
 * Decode one base64url JSON JWT segment.
 * @param {string} segment compact JWT segment
 * @param {string} label segment label
 * @returns {Record<string, unknown>}
 */
function decodeJwtObject(segment, label) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new OidcConfigurationError(
      'oidc_id_token_invalid',
      `ID Token ${label} is not valid base64url.`,
    );
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new OidcConfigurationError(
      'oidc_id_token_invalid',
      `ID Token ${label} is not valid JSON.`,
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new OidcConfigurationError(
      'oidc_id_token_invalid',
      `ID Token ${label} is not an object.`,
    );
  }
  return payload;
}

/**
 * Compare bounded protocol strings without exposing early length-based timing.
 * @param {unknown} actual actual claim
 * @param {string} expected expected claim
 * @returns {boolean}
 */
function constantTimeStringEqual(actual, expected) {
  if (typeof actual !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Validate an RS256 ID Token and required identity claims.
 * @param {{idToken: string, jwks: Record<string, unknown>, issuer: string, clientId: string, nonce: string, nowSeconds?: number}} input verification input
 * @returns {{email: string, subject: string, claims: Record<string, unknown>}}
 */
export function verifyIdToken({
  idToken,
  jwks,
  issuer,
  clientId,
  nonce,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  if (
    typeof idToken !== 'string'
    || idToken.length === 0
    || Buffer.byteLength(idToken) > MAX_ID_TOKEN_BYTES
  ) {
    throw new OidcConfigurationError(
      'oidc_id_token_invalid',
      'ID Token is missing or outside the accepted size boundary.',
    );
  }
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new OidcConfigurationError(
      'oidc_id_token_invalid',
      'ID Token must use compact JWS serialization.',
    );
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJwtObject(encodedHeader, 'header');
  const claims = decodeJwtObject(encodedClaims, 'claims');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new OidcConfigurationError(
      'oidc_id_token_algorithm_invalid',
      'ID Token must use an identified RS256 signing key.',
    );
  }
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const key = keys.find(
    (candidate) => candidate
      && typeof candidate === 'object'
      && candidate.kid === header.kid
      && candidate.kty === 'RSA'
      && (candidate.use == null || candidate.use === 'sig')
      && (candidate.alg == null || candidate.alg === 'RS256'),
  );
  if (!key) {
    throw new OidcConfigurationError(
      'oidc_signing_key_not_found',
      'No trusted RS256 signing key matches the ID Token.',
    );
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key, format: 'jwk' });
  } catch {
    throw new OidcConfigurationError(
      'oidc_signing_key_invalid',
      'The provider signing key is invalid.',
      502,
    );
  }
  let signature;
  try {
    signature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw new OidcConfigurationError(
      'oidc_id_token_invalid',
      'ID Token signature is not valid base64url.',
    );
  }
  const validSignature = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    publicKey,
    signature,
  );
  if (!validSignature) {
    throw new OidcConfigurationError(
      'oidc_id_token_signature_invalid',
      'ID Token signature verification failed.',
    );
  }
  if (claims.iss !== issuer) {
    throw new OidcConfigurationError(
      'oidc_id_token_issuer_invalid',
      'ID Token issuer does not match the discovered issuer.',
    );
  }
  const audiences = typeof claims.aud === 'string'
    ? [claims.aud]
    : Array.isArray(claims.aud)
      ? claims.aud.filter((audience) => typeof audience === 'string')
      : [];
  if (!audiences.includes(clientId)) {
    throw new OidcConfigurationError(
      'oidc_id_token_audience_invalid',
      'ID Token audience does not include this client.',
    );
  }
  if (audiences.length > 1 && claims.azp !== clientId) {
    throw new OidcConfigurationError(
      'oidc_id_token_authorized_party_invalid',
      'ID Token authorized party does not identify this client.',
    );
  }
  if (
    !Number.isSafeInteger(claims.exp)
    || claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS
  ) {
    throw new OidcConfigurationError(
      'oidc_id_token_expired',
      'ID Token is expired or missing a valid expiration.',
    );
  }
  if (
    !Number.isSafeInteger(claims.iat)
    || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS
  ) {
    throw new OidcConfigurationError(
      'oidc_id_token_issued_at_invalid',
      'ID Token issued-at time is missing or in the future.',
    );
  }
  if (
    claims.nbf != null
    && (!Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS)
  ) {
    throw new OidcConfigurationError(
      'oidc_id_token_not_before_invalid',
      'ID Token is not yet valid.',
    );
  }
  if (!constantTimeStringEqual(claims.nonce, nonce)) {
    throw new OidcConfigurationError(
      'oidc_id_token_nonce_invalid',
      'ID Token nonce does not match the authorization request.',
    );
  }
  if (
    typeof claims.sub !== 'string'
    || claims.sub.length === 0
    || claims.sub.length > 255
  ) {
    throw new OidcConfigurationError(
      'oidc_id_token_subject_invalid',
      'ID Token subject is missing or invalid.',
    );
  }
  if (
    typeof claims.email !== 'string'
    || claims.email.length > 320
    || !/^[^\s@]+@[^\s@]+$/.test(claims.email)
    || claims.email_verified !== true
  ) {
    throw new OidcConfigurationError(
      'oidc_id_token_email_invalid',
      'ID Token must contain a verified email address.',
    );
  }
  return {
    email: claims.email.toLowerCase(),
    subject: claims.sub,
    claims,
  };
}

/**
 * Load provider signing keys with a bounded cache.
 * @param {string} jwksUri provider JWKS endpoint
 * @returns {Promise<Record<string, unknown>>}
 */
async function providerJwks(jwksUri) {
  const now = Date.now();
  if (jwksCache && jwksCache.uri === jwksUri && jwksCache.expiresAt > now) {
    return jwksCache.value;
  }
  const value = await fetchJson(
    jwksUri,
    { headers: { accept: 'application/json' } },
    'oidc_jwks',
  );
  if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 100) {
    throw new OidcConfigurationError(
      'oidc_jwks_invalid',
      'The OpenID Provider returned no bounded signing-key set.',
      502,
    );
  }
  jwksCache = { uri: jwksUri, expiresAt: now + CACHE_TTL_MS, value };
  return value;
}

/**
 * Exchange an authorization code and verify the returned ID Token.
 * @param {{code: string, codeVerifier: string, nonce: string, redirectUri: string, nowSeconds?: number}} request callback values
 * @returns {Promise<{email: string, subject: string, claims: Record<string, unknown>}>}
 */
export async function exchangeAuthorizationCode({
  code,
  codeVerifier,
  nonce,
  redirectUri,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const configuration = oidcConfiguration();
  if (configuration.mock) {
    throw new OidcConfigurationError(
      'oidc_development_route_required',
      'Development OIDC must use the local explicit mock route.',
      500,
    );
  }
  const safeCode = boundedProtocolValue(code, 'authorization_code', 1, 4096);
  const safeVerifier = boundedProtocolValue(
    codeVerifier,
    'code_verifier',
    43,
    128,
  );
  const safeNonce = boundedProtocolValue(nonce, 'nonce', 32, 256);
  if (redirectUri !== configuration.redirectUri) {
    throw new OidcConfigurationError(
      'oidc_redirect_uri_mismatch',
      'OIDC callback redirect URI does not match the registered URI.',
    );
  }
  const discovery = await providerDiscovery(configuration);
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: safeCode,
    redirect_uri: configuration.redirectUri,
    client_id: configuration.clientId,
    code_verifier: safeVerifier,
  });
  const headers = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (discovery.tokenAuthMethods.includes('client_secret_basic')) {
    headers.authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(configuration.clientId)}:${encodeURIComponent(configuration.clientSecret)}`,
    ).toString('base64')}`;
  } else {
    form.set('client_secret', configuration.clientSecret);
  }
  const tokenResponse = await fetchJson(
    discovery.tokenEndpoint,
    { method: 'POST', headers, body: form.toString() },
    'oidc_token',
  );
  if (typeof tokenResponse.id_token !== 'string') {
    throw new OidcConfigurationError(
      'oidc_id_token_missing',
      'The OpenID Provider returned no ID Token.',
      502,
    );
  }
  const jwks = await providerJwks(discovery.jwksUri);
  return verifyIdToken({
    idToken: tokenResponse.id_token,
    jwks,
    issuer: discovery.issuer,
    clientId: configuration.clientId,
    nonce: safeNonce,
    nowSeconds,
  });
}
