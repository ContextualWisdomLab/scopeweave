import { Hono } from 'hono';
import { db } from './db.mjs';
import { hashApiToken, verifyToken } from './auth.mjs';
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
  if (process.env.SCOPEWEAVE_DEV !== '1' && !process.env.OIDC_ISSUER) {
    return guardRejectionThroughCoreAbuseControls(c, { error: 'sso not configured' });
  }
  return next();
}

/**
 * Shared ScopeWeave application and transport-security boundary.
 *
 * Every supported consumer, including the public Node server and tests that
 * mount this route graph directly, enters the same trusted-proxy-aware bounded
 * rate limiter before authentication hints, invitation lookups, OIDC guards, or
 * the internal implementation graph. Guard rejections are still accounted by
 * the core request logger/counters, while limiter rejections use the matching
 * bounded observability hooks without exposing client identity.
 */
export const app = new Hono();

const rateLimitObservability = createRateLimitObservability();
app.use('*', createRateLimitMiddleware(rateLimitObservability));
app.use(OIDC_ROUTE_PREFIX, failClosedWhenOidcIsUnconfigured);
app.use(INVITE_ACCEPT_PATH, bindInviteToAuthenticatedIdentity);
app.use(MEMBERS_PATH, redactPendingInviteTokens);
app.route('/', coreRoutes);
