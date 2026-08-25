import { Hono } from 'hono';
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from 'node:crypto';
import { db, rowid } from './db.mjs';
import {
  hashApiToken,
  hashPassword,
  signToken,
  verifyToken,
} from './auth.mjs';
import {
  createRateLimitMiddleware,
  createRateLimitObservability,
} from './rate_limit.mjs';

const configuredRateLimitMax = process.env.SCOPEWEAVE_RATE_LIMIT_MAX;
let coreRoutes;
try {
  // application_routes_core.mjs retains the historical header-keyed limiter
  // only as an internal compatibility detail. Every supported entrypoint loads
  // that implementation with the legacy limiter disabled, then applies the
  // transport-peer-aware policy below before any route-specific guard or DB
  // lookup. Restoring the operator value before request handling keeps the
  // process environment truthful for diagnostics and child integrations.
  process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '0';
  ({ app: coreRoutes } = await import('./application_routes_core.mjs'));
} finally {
  if (configuredRateLimitMax === undefined) delete process.env.SCOPEWEAVE_RATE_LIMIT_MAX;
  else process.env.SCOPEWEAVE_RATE_LIMIT_MAX = configuredRateLimitMax;
}

const GUARD_ACCOUNTING_METHOD = Symbol.for('scopeweave.guard_accounting.original_method');
const MEMBERS_PATH = '/api/orgs/:id/members';
const INVITE_ACCEPT_PATH = '/api/invites/:token/accept';
const OIDC_ROUTE_PREFIX = '/api/auth/oidc/*';
const OIDC_ISSUER = String(process.env.OIDC_ISSUER || '').replace(/\/$/, '');
const OIDC_CLIENT_ID = String(process.env.OIDC_CLIENT_ID || '');
const OIDC_CLIENT_SECRET = String(process.env.OIDC_CLIENT_SECRET || '');
const OIDC_REDIRECT_URI = String(process.env.OIDC_REDIRECT_URI || '');
const productionOidcConfigured = Boolean(OIDC_ISSUER && OIDC_CLIENT_ID && OIDC_CLIENT_SECRET);
const productionOidcStates = new Map();

function normalizeIdentityEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function authenticatedIdentityHint(c) {
  const header = c.req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;

  if (token.startsWith('swk_')) {
    const user = db.prepare(
      `SELECT u.id, u.email FROM api_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`,
    ).get(hashApiToken(token));
    return user ? { id: user.id, email: normalizeIdentityEmail(user.email) } : null;
  }

  try {
    const payload = verifyToken(token);
    const user = db.prepare('SELECT id, email, token_version FROM users WHERE id = ?').get(payload.sub);
    if (!user || Number(payload.tv ?? 0) !== Number(user.token_version ?? 0)) return null;
    return { id: user.id, email: normalizeIdentityEmail(user.email) };
  } catch {
    return null;
  }
}

async function guardRejectionThroughCoreAbuseControls(c, errorBody) {
  // The shared rate limiter has already accepted this request before any guard
  // runs. A non-mutating OPTIONS probe at the same path lets the internal core
  // request logger and counters account for a guard rejection without reaching
  // a mutating route. The core limiter is disabled for this supported boundary,
  // so forwarded-address data and credentials do not need to enter the probe.
  const accountingEnvironment = Object.assign(Object.create(null), c.env || {});
  accountingEnvironment[GUARD_ACCOUNTING_METHOD] = c.req.method;
  await coreRoutes.request(
    c.req.url,
    { method: 'OPTIONS' },
    accountingEnvironment,
  );
  return c.json(errorBody, 404);
}

async function bindInviteToAuthenticatedIdentity(c, next) {
  // This guard only narrows access after confirming that the presented
  // credential is still live. The core requireAuth middleware remains the
  // authoritative authentication/RBAC boundary and repeats that validation
  // before any invite mutation.
  const identity = authenticatedIdentityHint(c);
  if (!identity) return next();

  const invite = db.prepare('SELECT email, accepted_at FROM invites WHERE token = ?')
    .get(c.req.param('token'));
  if (!invite || invite.accepted_at) return next();

  const invitedEmail = normalizeIdentityEmail(invite.email);
  if (!invitedEmail || !identity.email || invitedEmail !== identity.email) {
    return guardRejectionThroughCoreAbuseControls(c, { error: 'invalid or used invite' });
  }
  return next();
}

async function redactPendingInviteTokens(c, next) {
  await next();
  const response = c.res;
  if (response.status !== 200) return;

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return;
  }
  if (!Array.isArray(payload?.invites)) return;

  const invites = payload.invites.map(({ token: _token, ...invite }) => invite);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  c.res = new Response(JSON.stringify({ ...payload, invites }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function failClosedWhenOidcIsUnconfigured(c, next) {
  if (process.env.SCOPEWEAVE_DEV !== '1' && !productionOidcConfigured) {
    return guardRejectionThroughCoreAbuseControls(c, { error: 'sso not configured' });
  }
  return next();
}

function productionOidcRedirectUri(c) {
  return OIDC_REDIRECT_URI || `${new URL(c.req.url).origin}/api/auth/oidc/callback`;
}

function parseJwtJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

async function verifyProductionOidcIdentity(idToken, expectedNonce) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('invalid_oidc_token_shape');

  const header = parseJwtJson(parts[0]);
  const claims = parseJwtJson(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new Error('unsupported_oidc_signature');
  }

  const discoveryResponse = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!discoveryResponse.ok) throw new Error('oidc_discovery_failed');
  const discovery = await discoveryResponse.json();
  if (discovery?.issuer !== OIDC_ISSUER || typeof discovery?.jwks_uri !== 'string') {
    throw new Error('oidc_discovery_mismatch');
  }

  const jwksUrl = new URL(discovery.jwks_uri);
  if (jwksUrl.protocol !== 'https:') throw new Error('oidc_jwks_requires_https');
  const jwksResponse = await fetch(jwksUrl, { signal: AbortSignal.timeout(5000) });
  if (!jwksResponse.ok) throw new Error('oidc_jwks_failed');
  const jwks = await jwksResponse.json();
  const jwk = Array.isArray(jwks?.keys)
    ? jwks.keys.find((candidate) => (
      candidate?.kid === header.kid
      && candidate?.kty === 'RSA'
      && (!candidate.use || candidate.use === 'sig')
      && (!candidate.alg || candidate.alg === 'RS256')
    ))
    : null;
  if (!jwk) throw new Error('oidc_signing_key_not_found');

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  if (!verifySignature('RSA-SHA256', signed, publicKey, signature)) {
    throw new Error('oidc_signature_invalid');
  }

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const hasExpectedAudience = audiences.includes(OIDC_CLIENT_ID);
  const authorizedPartyMatches = audiences.length <= 1 || claims.azp === OIDC_CLIENT_ID;
  const temporalClaimsValid = Number.isFinite(claims.exp)
    && claims.exp > now
    && (!Number.isFinite(claims.nbf) || claims.nbf <= now + 60)
    && (!Number.isFinite(claims.iat) || claims.iat <= now + 60);
  const identityClaimsValid = claims.iss === OIDC_ISSUER
    && hasExpectedAudience
    && authorizedPartyMatches
    && temporalClaimsValid
    && claims.nonce === expectedNonce
    && typeof claims.sub === 'string'
    && claims.sub.length > 0
    && claims.email_verified === true
    && typeof claims.email === 'string'
    && normalizeIdentityEmail(claims.email).length > 0;
  if (!identityClaimsValid) throw new Error('oidc_claims_invalid');

  return normalizeIdentityEmail(claims.email);
}

function upsertProductionSsoUser(email) {
  let user = db.prepare('SELECT id, email, token_version FROM users WHERE email = ?').get(email);
  if (user) return user;

  db.exec('BEGIN');
  try {
    const uid = rowid(db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)')
      .run(email, hashPassword(randomBytes(24).toString('hex')), ''));
    const orgId = rowid(db.prepare('INSERT INTO orgs(name,owner_id) VALUES(?,?)')
      .run(`${email}'s workspace`, uid));
    db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(orgId, uid, 'owner');
    db.exec('COMMIT');
    user = { id: uid, email, token_version: 0 };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return user;
}

async function productionOidcStart(c, next) {
  if (process.env.SCOPEWEAVE_DEV === '1' || !productionOidcConfigured) return next();

  let authorizationUrl;
  try {
    authorizationUrl = new URL(`${OIDC_ISSUER}/authorize`);
    if (authorizationUrl.protocol !== 'https:') throw new Error('oidc_issuer_requires_https');
  } catch {
    return c.json({ error: 'sso not configured' }, 404, { 'Cache-Control': 'no-store' });
  }

  const state = randomBytes(16).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  productionOidcStates.set(state, { verifier, nonce, exp: Date.now() + 5 * 60 * 1000 });

  authorizationUrl.searchParams.set('client_id', OIDC_CLIENT_ID);
  authorizationUrl.searchParams.set('redirect_uri', productionOidcRedirectUri(c));
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('scope', 'openid email profile');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('nonce', nonce);
  authorizationUrl.searchParams.set('code_challenge', challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  return c.redirect(authorizationUrl.toString());
}

async function productionOidcCallback(c, next) {
  if (process.env.SCOPEWEAVE_DEV === '1' || !productionOidcConfigured) return next();

  const state = c.req.query('state');
  const code = c.req.query('code');
  const pending = productionOidcStates.get(state);
  if (!pending || pending.exp < Date.now() || !code) {
    productionOidcStates.delete(state);
    return c.json({ error: 'invalid or expired state' }, 400, { 'Cache-Control': 'no-store' });
  }
  productionOidcStates.delete(state);

  try {
    const tokenResponse = await fetch(`${OIDC_ISSUER}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: productionOidcRedirectUri(c),
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
        code_verifier: pending.verifier,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!tokenResponse.ok) throw new Error('oidc_token_exchange_failed');
    const tokens = await tokenResponse.json();
    const email = await verifyProductionOidcIdentity(tokens?.id_token, pending.nonce);
    const user = upsertProductionSsoUser(email);
    const token = signToken({ sub: user.id, email: user.email, tv: user.token_version || 0 });
    return c.redirect(`/#token=${token}`);
  } catch {
    return c.json({ error: 'invalid identity token' }, 400, { 'Cache-Control': 'no-store' });
  }
}

/**
 * Shared ScopeWeave application and transport-security boundary.
 *
 * Every supported consumer, including the public Node server and tests that
 * mount this route graph directly, enters the same trusted-proxy-aware bounded
 * rate limiter before authentication hints, invitation lookups, OIDC guards, or
 * the internal implementation graph. Production OIDC authorization-code
 * callbacks terminate here only after RS256/JWKS signature validation and
 * issuer, audience, expiry, nonce, subject, and verified-email checks. Guard
 * rejections are still accounted by the core request logger/counters, while
 * limiter rejections use the matching bounded observability hooks without
 * exposing client identity.
 */
export const app = new Hono();

const rateLimitObservability = createRateLimitObservability();
app.use('*', createRateLimitMiddleware(rateLimitObservability));
app.use(OIDC_ROUTE_PREFIX, failClosedWhenOidcIsUnconfigured);
app.get('/api/auth/oidc/start', productionOidcStart);
app.get('/api/auth/oidc/callback', productionOidcCallback);
app.use(INVITE_ACCEPT_PATH, bindInviteToAuthenticatedIdentity);
app.use(MEMBERS_PATH, redactPendingInviteTokens);
app.route('/', coreRoutes);
