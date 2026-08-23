import { Hono } from 'hono';
import { app as coreRoutes } from './application_routes_core.mjs';
import { db } from './db.mjs';
import { hashApiToken, verifyToken } from './auth.mjs';

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
  // The security guards intentionally run before the legacy implementation
  // graph so a rejected request cannot reach the unsafe historical handler.
  // A non-mutating OPTIONS probe at the same path lets the existing core
  // request logger, metrics and rate limiter account for that rejection. Only
  // the current forwarded-address input is copied into probe headers so the
  // present core limiter sees the same input; bodies and authorization are not.
  // A process-local environment symbol retains the attempted method solely for
  // structured logging while routing the probe as OPTIONS.
  const headers = new Headers();
  const forwardedFor = c.req.header('x-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);
  const accountingEnvironment = Object.assign(Object.create(null), c.env || {});
  accountingEnvironment[GUARD_ACCOUNTING_METHOD] = c.req.method;
  const probe = await coreRoutes.request(
    c.req.url,
    { method: 'OPTIONS', headers },
    accountingEnvironment,
  );
  if (probe.status === 429) return probe;
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
 * Shared ScopeWeave application boundary.
 *
 * Every consumer, including the public server and tests that mount this route
 * graph directly, passes through the same invite and OIDC trust controls before
 * the protected implementation graph runs. Rejected guards are still accounted
 * by the core graph's existing abuse-control and observability middleware.
 */
export const app = new Hono();

app.use(OIDC_ROUTE_PREFIX, failClosedWhenOidcIsUnconfigured);
app.use(INVITE_ACCEPT_PATH, bindInviteToAuthenticatedIdentity);
app.use(MEMBERS_PATH, redactPendingInviteTokens);
app.route('/', coreRoutes);
