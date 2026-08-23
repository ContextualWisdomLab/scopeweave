import { Hono } from 'hono';
import { app as coreRoutes } from './application_routes_core.mjs';
import { db } from './db.mjs';
import { hashApiToken, verifyToken } from './auth.mjs';

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

  let uid;
  if (token.startsWith('swk_')) {
    uid = db.prepare('SELECT user_id FROM api_tokens WHERE token_hash = ?')
      .get(hashApiToken(token))?.user_id;
  } else {
    try {
      uid = verifyToken(token).sub;
    } catch {
      return null;
    }
  }
  if (uid === undefined || uid === null) return null;
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(uid);
  return user ? { id: user.id, email: normalizeIdentityEmail(user.email) } : null;
}

async function bindInviteToAuthenticatedIdentity(c, next) {
  // This guard only narrows access. The core requireAuth middleware remains the
  // authority that accepts/rejects the credential and enforces token_version.
  const identity = authenticatedIdentityHint(c);
  if (!identity) return next();

  const invite = db.prepare('SELECT email, accepted_at FROM invites WHERE token = ?')
    .get(c.req.param('token'));
  if (!invite || invite.accepted_at) return next();

  const invitedEmail = normalizeIdentityEmail(invite.email);
  if (!invitedEmail || !identity.email || invitedEmail !== identity.email) {
    return c.json({ error: 'invalid or used invite' }, 404);
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
    return c.json({ error: 'sso not configured' }, 404);
  }
  return next();
}

/**
 * Shared ScopeWeave application boundary.
 *
 * Every consumer, including the public server and tests that mount this route
 * graph directly, passes through the same invite and OIDC trust controls before
 * the protected implementation graph runs. The implementation module remains
 * internal; this module is the supported route-graph entry point.
 */
export const app = new Hono();

app.use(OIDC_ROUTE_PREFIX, failClosedWhenOidcIsUnconfigured);
app.use(INVITE_ACCEPT_PATH, bindInviteToAuthenticatedIdentity);
app.use(MEMBERS_PATH, redactPendingInviteTokens);
app.route('/', coreRoutes);
