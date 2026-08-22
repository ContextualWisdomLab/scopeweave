// ScopeWeave API security facade.
//
// The historical Hono route graph remains in app_core.mjs so bounded security
// policy can be added without rewriting unrelated tenant, auth, billing, or
// Clearfolio behavior. Every production server and in-process caller imports
// this facade; app_core.mjs is an implementation module, not a public entrypoint.
import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { app as coreApp } from './app_core.mjs';
import { db } from './db.mjs';
import {
  WebhookDestinationError,
  fetchPublicHttps,
  postWebhook,
  validateWebhookRegistrationUrl,
} from './webhook_transport.mjs';

const nativeFetch = globalThis.fetch.bind(globalThis);
const webhookFetchBoundaryKey = Symbol.for('scopeweave.webhook-fetch-boundary');
const WEBHOOK_REGISTRATION_PATH = /^\/api\/orgs\/[^/]+\/webhooks$/;
const WEBHOOK_REGISTRATION_BODY_MAX_BYTES = 16 * 1024;
const AUDIT_PATH = /^\/api\/orgs\/[^/]+\/audit$/;
const AUTH_EMAIL_PATH = /^\/api\/auth\/(?:signup|login)$/;
const METRICS_PATH = '/api/metrics';
const LEGACY_WEBHOOK_URL_REQUIRED_ERROR = 'valid http(s) url required';
const OIDC_ISSUER = process.env.OIDC_ISSUER
  ? process.env.OIDC_ISSUER.replace(/\/$/, '')
  : null;
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || '';
const OIDC_TOKEN_URL = OIDC_ISSUER ? `${OIDC_ISSUER}/token` : null;
const OIDC_TOKEN_TIMEOUT_MS = 3000;
const OIDC_DISCOVERY_TTL_MS = 60 * 1000;
const OIDC_JWKS_TTL_MS = 60 * 1000;
const OIDC_STATE_TTL_MS = 5 * 60 * 1000;
const OIDC_STATE_MAX_ENTRIES = 256;
const OIDC_CLOCK_SKEW_SECONDS = 60;
const oidcNonceByState = new Map();
const oidcNonceByCode = new Map();
const facadeMetrics = { requests: 0, s2xx: 0, s4xx: 0, s5xx: 0 };
const quietFacadeLogs = String(process.env.SCOPEWEAVE_DB || '').includes(':memory:');
let oidcDiscoveryCache = null;
let oidcSigningKeyCache = null;

function matchingStoredEmails(email) {
  return db.prepare(
    'SELECT email FROM users WHERE email = ? COLLATE NOCASE ORDER BY id LIMIT 2',
  ).all(email);
}

function observeFacadeResponse(request, response, startedAt = Date.now()) {
  facadeMetrics.requests += 1;
  if (response.status >= 500) facadeMetrics.s5xx += 1;
  else if (response.status >= 400) facadeMetrics.s4xx += 1;
  else if (response.status >= 200) facadeMetrics.s2xx += 1;
  if (!quietFacadeLogs) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
      ms: Date.now() - startedAt,
    }));
  }
  return response;
}

async function mergeFacadeMetricsResponse(request, response) {
  if (
    request.method !== 'GET'
    || new URL(request.url).pathname !== METRICS_PATH
    || !response.ok
  ) return response;

  const payload = await response.clone().json().catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return response;
  const merged = { ...payload };
  for (const key of Object.keys(facadeMetrics)) {
    merged[key] = (Number(merged[key]) || 0) + facadeMetrics[key];
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(merged), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isSignedWebhookRequest(request) {
  if (request.method.toUpperCase() !== 'POST') return false;
  return Boolean(
    request.headers.get('x-scopeweave-event')
      && /^sha256=[0-9a-f]{64}$/i.test(
        request.headers.get('x-scopeweave-signature') || '',
      ),
  );
}

function isOidcTokenRequest(request) {
  return OIDC_TOKEN_URL !== null
    && request.method.toUpperCase() === 'POST'
    && request.url === OIDC_TOKEN_URL;
}

async function protectedWebhookFetch(request) {
  const body = request.body
    ? new Uint8Array(await request.clone().arrayBuffer())
    : '';
  const result = await postWebhook(request.url, {
    headers: Object.fromEntries(request.headers.entries()),
    body,
    signal: request.signal,
  });
  // Preserve fetch's Response contract for callers. Informational/invalid
  // status codes cannot construct a standard Response and are represented as a
  // network-style error response instead of leaking a transport-only object.
  if (result.status >= 200 && result.status <= 599) {
    return new Response(null, { status: result.status });
  }
  return Response.error();
}

function parseJwtObject(segment) {
  const value = JSON.parse(Buffer.from(String(segment || ''), 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid token');
  return value;
}

function audienceMatches(claims) {
  if (typeof claims.aud === 'string') return claims.aud === OIDC_CLIENT_ID;
  if (!Array.isArray(claims.aud) || !claims.aud.includes(OIDC_CLIENT_ID)) return false;
  return claims.aud.length === 1
    ? (!claims.azp || claims.azp === OIDC_CLIENT_ID)
    : claims.azp === OIDC_CLIENT_ID;
}

function validateOidcEndpoint(value, label) {
  let endpoint;
  try {
    endpoint = new URL(String(value || ''));
  } catch {
    throw new Error(`invalid ${label}`);
  }
  if (endpoint.username || endpoint.password || endpoint.hash || !endpoint.hostname) {
    throw new Error(`invalid ${label}`);
  }
  if (isDevelopmentLoopbackHttp(endpoint)) return endpoint.toString();
  if (endpoint.protocol !== 'https:') throw new Error(`invalid ${label}`);
  try {
    return validateWebhookRegistrationUrl(endpoint.toString());
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

async function fetchOidcEndpoint(
  value,
  label,
  { method = 'GET', headers = {}, body, signal } = {},
) {
  const endpoint = validateOidcEndpoint(value, label);
  if (isDevelopmentLoopbackHttp(endpoint)) {
    return nativeFetch(new Request(endpoint, {
      method,
      headers,
      body,
      redirect: 'error',
      signal,
    }));
  }
  return fetchPublicHttps(endpoint, {
    method,
    headers,
    body,
    signal,
  });
}

async function oidcProviderJson(url) {
  const response = await fetchOidcEndpoint(url, 'provider endpoint', {
    signal: AbortSignal.timeout(OIDC_TOKEN_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('provider unavailable');
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid provider response');
  return payload;
}

async function loadOidcDiscovery(now = Date.now()) {
  if (oidcDiscoveryCache && oidcDiscoveryCache.expiresAt > now) {
    return oidcDiscoveryCache.value;
  }
  const discovery = await oidcProviderJson(`${OIDC_ISSUER}/.well-known/openid-configuration`);
  if (discovery.issuer !== OIDC_ISSUER) throw new Error('invalid discovery');
  const value = Object.freeze({
    ...discovery,
    authorization_endpoint: validateOidcEndpoint(discovery.authorization_endpoint, 'authorization endpoint'),
    token_endpoint: validateOidcEndpoint(discovery.token_endpoint, 'token endpoint'),
    jwks_uri: validateOidcEndpoint(discovery.jwks_uri, 'jwks url'),
  });
  oidcDiscoveryCache = { value, expiresAt: now + OIDC_DISCOVERY_TTL_MS };
  return value;
}

async function loadOidcSigningKey(discovery, kid, now = Date.now()) {
  if (
    oidcSigningKeyCache
    && oidcSigningKeyCache.expiresAt > now
    && oidcSigningKeyCache.jwksUri === discovery.jwks_uri
    && oidcSigningKeyCache.kid === kid
  ) {
    return oidcSigningKeyCache.key;
  }

  const jwks = await oidcProviderJson(discovery.jwks_uri);
  const keyData = Array.isArray(jwks.keys)
    ? jwks.keys.find((candidate) => (
      candidate
        && candidate.kid === kid
        && candidate.kty === 'RSA'
        && (!candidate.use || candidate.use === 'sig')
        && (!candidate.alg || candidate.alg === 'RS256')
    ))
    : null;
  if (!keyData) throw new Error('signing key unavailable');
  const key = createPublicKey({ key: keyData, format: 'jwk' });
  oidcSigningKeyCache = {
    jwksUri: discovery.jwks_uri,
    kid,
    key,
    expiresAt: now + OIDC_JWKS_TTL_MS,
  };
  return key;
}

async function verifyOidcIdToken(idToken, expectedNonce, discovery) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('invalid token');
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = parseJwtObject(encodedHeader);
  const claims = parseJwtObject(encodedClaims);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) throw new Error('invalid algorithm');

  const key = await loadOidcSigningKey(discovery, header.kid);
  if (!verifySignature(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    key,
    Buffer.from(encodedSignature, 'base64url'),
  )) throw new Error('invalid signature');

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== OIDC_ISSUER || !audienceMatches(claims)) throw new Error('invalid token binding');
  if (!Number.isInteger(claims.exp) || claims.exp <= now - OIDC_CLOCK_SKEW_SECONDS) throw new Error('expired token');
  if (
    claims.nbf !== undefined
    && (!Number.isInteger(claims.nbf) || claims.nbf > now + OIDC_CLOCK_SKEW_SECONDS)
  ) throw new Error('token not active');
  if (!Number.isInteger(claims.iat) || claims.iat > now + OIDC_CLOCK_SKEW_SECONDS) throw new Error('invalid issued-at');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.nonce !== expectedNonce) throw new Error('invalid subject or nonce');
  if (typeof claims.email !== 'string' || !claims.email.trim()) throw new Error('missing email');
}

async function boundedOidcFetch(request) {
  const body = await request.clone().arrayBuffer();
  const form = new URLSearchParams(new TextDecoder().decode(body));
  const code = form.get('code');
  const expectedNonce = code ? oidcNonceByCode.get(code) : null;
  if (!expectedNonce || expectedNonce.exp <= Date.now()) throw new Error('OIDC flow binding unavailable');
  const discovery = await loadOidcDiscovery();
  const signal = AbortSignal.any([
    request.signal,
    expectedNonce.callbackSignal,
    AbortSignal.timeout(OIDC_TOKEN_TIMEOUT_MS),
  ]);
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const response = await fetchOidcEndpoint(discovery.token_endpoint, 'token endpoint', {
    method: request.method,
    headers: Object.fromEntries(headers.entries()),
    body: new Uint8Array(body),
    signal,
  });
  if (!response.ok) return response;
  const tokenPayload = await response.clone().json();
  await verifyOidcIdToken(tokenPayload.id_token, expectedNonce.nonce, discovery);
  return response;
}

// Install exactly once per process. The server's signed webhook POSTs are
// routed through the SSRF-safe transport, and the configured OIDC token exchange
// gets a bounded provider budget plus signature/issuer/audience/nonce validation.
// Clearfolio, billing, and unrelated fetch users retain native fetch semantics.
// Constructing an effective Request first makes Request-object inputs and init
// overrides follow the same security decision as URL+init calls.
if (!globalThis[webhookFetchBoundaryKey]) {
  globalThis.fetch = async (input, init = undefined) => {
    const effectiveRequest = new Request(input, init);
    if (isSignedWebhookRequest(effectiveRequest)) {
      return protectedWebhookFetch(effectiveRequest);
    }
    if (isOidcTokenRequest(effectiveRequest)) {
      return boundedOidcFetch(effectiveRequest);
    }
    return nativeFetch(effectiveRequest);
  };
  Object.defineProperty(globalThis, webhookFetchBoundaryKey, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function isDevelopmentLoopbackHttp(value) {
  if (process.env.SCOPEWEAVE_DEV !== '1') return false;
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return url.protocol === 'http:'
      && !url.username
      && !url.password
      && !url.hash
      && (host === 'localhost' || host === '127.0.0.1' || host === '::1');
  } catch {
    return false;
  }
}

function requestWithJson(request, payload) {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(payload),
    signal: request.signal,
  });
}

async function canonicalInboundRequest(request) {
  const url = new URL(request.url);

  if (request.method === 'POST' && AUTH_EMAIL_PATH.test(url.pathname)) {
    const payload = await request.clone().json().catch(() => null);
    if (
      payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && typeof payload.email === 'string'
    ) {
      const trimmedEmail = payload.email.trim();
      const storedMatches = matchingStoredEmails(trimmedEmail);
      const email = url.pathname.endsWith('/signup')
        ? (storedMatches[0]?.email || trimmedEmail.toLowerCase())
        : (storedMatches.length === 1 ? storedMatches[0].email : trimmedEmail);
      if (email !== payload.email) return requestWithJson(request, { ...payload, email });
    }
  }

  if (request.method === 'GET' && AUDIT_PATH.test(url.pathname)) {
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null) {
      const requested = Number(rawLimit);
      const limit = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), 500)
        : 100;
      if (String(limit) !== rawLimit) {
        url.searchParams.set('limit', String(limit));
        return new Request(url, request);
      }
    }
  }

  return request;
}

function cleanupOidcNonces(now = Date.now()) {
  for (const [state, record] of oidcNonceByState.entries()) {
    if (record.exp <= now) oidcNonceByState.delete(state);
  }
}

function bindOidcStartNonce(request, response, discovery) {
  if (!OIDC_ISSUER || request.method !== 'GET' || new URL(request.url).pathname !== '/api/auth/oidc/start') return response;
  if (response.status !== 302) return response;
  const location = response.headers.get('location');
  if (!location) return response;
  const generatedAuthorization = new URL(location);
  const authorization = new URL(discovery.authorization_endpoint);
  for (const [name, value] of generatedAuthorization.searchParams.entries()) {
    authorization.searchParams.set(name, value);
  }
  const state = authorization.searchParams.get('state');
  if (!state) return response;
  const nonce = randomBytes(16).toString('base64url');
  oidcNonceByState.set(state, { nonce, exp: Date.now() + OIDC_STATE_TTL_MS });
  authorization.searchParams.set('nonce', nonce);
  const headers = new Headers(response.headers);
  headers.set('location', authorization.toString());
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function coreFetchWithOidcBinding(request, rest) {
  const startedAt = Date.now();
  const requestUrl = new URL(request.url);
  if (!OIDC_ISSUER) {
    if (
      process.env.SCOPEWEAVE_DEV !== '1'
      && requestUrl.pathname.startsWith('/api/auth/oidc/')
    ) {
      return observeFacadeResponse(
        request,
        Response.json({ error: 'not found' }, { status: 404 }),
        startedAt,
      );
    }
    return coreApp.fetch(request, ...rest);
  }
  if (request.method !== 'GET') {
    return coreApp.fetch(request, ...rest);
  }
  if (requestUrl.pathname === '/api/auth/oidc/start') {
    cleanupOidcNonces();
    if (oidcNonceByState.size >= OIDC_STATE_MAX_ENTRIES) {
      return observeFacadeResponse(
        request,
        Response.json(
          { error: 'OIDC temporarily unavailable' },
          { status: 503 },
        ),
        startedAt,
      );
    }
    let discovery;
    try {
      discovery = await loadOidcDiscovery();
    } catch {
      return observeFacadeResponse(
        request,
        Response.json({ error: 'OIDC provider unavailable' }, { status: 502 }),
        startedAt,
      );
    }
    const response = await coreApp.fetch(request, ...rest);
    return bindOidcStartNonce(request, response, discovery);
  }
  if (requestUrl.pathname !== '/api/auth/oidc/callback') {
    return coreApp.fetch(request, ...rest);
  }

  const state = requestUrl.searchParams.get('state');
  const code = requestUrl.searchParams.get('code');
  const record = state ? oidcNonceByState.get(state) : null;
  if (state) oidcNonceByState.delete(state);
  if (code && record && record.exp > Date.now()) {
    oidcNonceByCode.set(code, { ...record, callbackSignal: request.signal });
  }
  try {
    return await coreApp.fetch(request, ...rest);
  } finally {
    if (code) oidcNonceByCode.delete(code);
  }
}

function authorizationProbeRequest(request) {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: '', events: [] }),
    signal: request.signal,
  });
}

/**
 * Run a controlled, side-effect-free webhook registration through the real
 * authentication, rate-limit, and tenant-role chain before this facade returns
 * a destination-policy error. The synthetic payload is valid JSON but has an
 * empty URL, so an authorized manager deterministically reaches the legacy
 * pre-insert URL guard and receives 400. Every denial, rate limit, or internal
 * failure is propagated unchanged. Because the probe uses the customer's real
 * POST path and method, request metrics and structured logs reflect that
 * customer-visible operation instead of a synthetic GET.
 */
async function deniedRegistrationAuthorization(request, rest) {
  const response = await coreApp.fetch(authorizationProbeRequest(request), ...rest);
  if (response.status !== 400) return response;
  const payload = await response.clone().json().catch(() => null);
  return payload?.error === LEGACY_WEBHOOK_URL_REQUIRED_ERROR ? null : response;
}

function declaredRegistrationBodyTooLarge(request) {
  const rawLength = request.headers.get('content-length');
  if (rawLength === null) return false;
  const declaredLength = Number(rawLength);
  return Number.isFinite(declaredLength)
    && declaredLength > WEBHOOK_REGISTRATION_BODY_MAX_BYTES;
}

/**
 * Read one webhook-registration payload with an explicit memory budget.
 *
 * The original request stream is consumed directly instead of cloning it: a
 * cloned stream can let the unread tee branch buffer attacker-controlled data.
 * Callers reconstruct the small JSON request only after this bounded read.
 */
async function readBoundedRegistrationJson(request) {
  if (!request.body) return { payload: {}, tooLarge: false };
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > WEBHOOK_REGISTRATION_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { payload: {}, tooLarge: true };
      }
      chunks.push(chunk);
    }
  } catch {
    return { payload: {}, tooLarge: false };
  } finally {
    try { reader.releaseLock(); } catch { /* already released/cancelled */ }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      payload: JSON.parse(new TextDecoder().decode(bytes)),
      tooLarge: false,
    };
  } catch {
    return { payload: {}, tooLarge: false };
  }
}

function canonicalRegistrationRequest(request, payload, canonicalUrl) {
  return requestWithJson(request, { ...payload, url: canonicalUrl });
}

async function registrationPolicyResult(request, rest) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || !WEBHOOK_REGISTRATION_PATH.test(url.pathname)) {
    return null;
  }

  // Requests with no credential material can be rejected by the core
  // requireAuth middleware without touching their body at all. Credential-bearing
  // requests may still be forged, so any pre-auth policy read remains bounded.
  if (!request.headers.get('authorization')) return { request };

  let payload;
  let tooLarge = declaredRegistrationBodyTooLarge(request);
  if (!tooLarge) {
    const parsed = await readBoundedRegistrationJson(request);
    payload = parsed.payload;
    tooLarge = parsed.tooLarge;
  }

  if (tooLarge) {
    const authorization = await deniedRegistrationAuthorization(request, rest);
    if (authorization) return { response: authorization };
    return {
      response: Response.json(
        { error: 'webhook registration body too large' },
        { status: 413 },
      ),
    };
  }

  try {
    const canonicalUrl = validateWebhookRegistrationUrl(payload?.url);
    return {
      request: canonicalRegistrationRequest(request, payload, canonicalUrl),
    };
  } catch (error) {
    // Preserve the existing dev-only localhost failure-path smoke fixture. The
    // outbound transport still refuses HTTP, so this exception cannot create a
    // server-side connection and production never inherits it.
    if (
      error instanceof WebhookDestinationError
      && isDevelopmentLoopbackHttp(payload?.url)
    ) {
      return { request: requestWithJson(request, payload) };
    }
    const authorization = await deniedRegistrationAuthorization(request, rest);
    if (authorization) return { response: authorization };
    return {
      response: Response.json(
        { error: 'valid public https webhook URL required' },
        { status: 400 },
      ),
    };
  }
}

async function secureFetch(request, ...rest) {
  const canonicalRequest = await canonicalInboundRequest(request);
  const policy = await registrationPolicyResult(canonicalRequest, rest);
  if (policy?.response) return policy.response;
  const effectiveRequest = policy?.request || canonicalRequest;
  const response = await coreFetchWithOidcBinding(effectiveRequest, rest);
  return mergeFacadeMetricsResponse(effectiveRequest, response);
}

async function secureRequest(input, init, ...rest) {
  const request = input instanceof Request
    ? (init === undefined ? input : new Request(input, init))
    : new Request(new URL(String(input), 'http://localhost'), init);
  return secureFetch(request, ...rest);
}

// Proxying preserves Hono route/introspection properties for existing callers
// while forcing both server fetches and in-process app.request tests through the
// registration, identity, and request-boundary policies above.
export const app = new Proxy(coreApp, {
  get(target, property) {
    if (property === 'fetch') return secureFetch;
    if (property === 'request') return secureRequest;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});