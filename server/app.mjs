import { Hono } from 'hono';
import { app as applicationRoutes } from './application_routes.mjs';
import { db } from './db.mjs';
import { StripeWebhookError, verifyStripeWebhookRequest } from './stripe_webhook.mjs';

const MEMBERS_PATH = '/api/orgs/:id/members';
const INVITE_ACCEPT_PATH = '/api/invites/:token/accept';
const OIDC_ROUTE_PREFIX = '/api/auth/oidc/';

function normalizeIdentityEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function bindInviteToAuthenticatedIdentity(handler) {
  return async (c, next) => {
    // Hono represents `requireAuth` and the final endpoint as consecutive route
    // handlers. The first pass has no user yet and delegates to requireAuth; the
    // second pass sees the authenticated identity before the legacy mutation.
    const uid = c.get('user')?.sub;
    if (uid !== undefined && uid !== null) {
      const invite = db.prepare('SELECT email, accepted_at FROM invites WHERE token = ?')
        .get(c.req.param('token'));
      if (invite && !invite.accepted_at) {
        const user = db.prepare('SELECT email FROM users WHERE id = ?').get(uid);
        if (normalizeIdentityEmail(user?.email) !== normalizeIdentityEmail(invite.email)) {
          return c.json({ error: 'invalid or used invite' }, 404);
        }
      }
    }
    return handler(c, next);
  };
}

function redactPendingInviteTokens(handler) {
  return async (c, next) => {
    const result = await handler(c, next);
    const response = result instanceof Response ? result : c.res;
    if (response.status !== 200) return result;

    const payload = await response.clone().json();
    const invites = payload.invites.map(({ token: _token, ...invite }) => invite);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    const sanitized = new Response(JSON.stringify({ ...payload, invites }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    c.res = sanitized;
    return sanitized;
  };
}

function failClosedWhenOidcIsUnconfigured(handler) {
  return async (c, next) => {
    if (process.env.SCOPEWEAVE_DEV !== '1' && !process.env.OIDC_ISSUER) {
      return c.json({ error: 'sso not configured' }, 404);
    }
    return handler(c, next);
  };
}

function secureCopiedHandler(route) {
  if (route.method === 'GET' && route.path.startsWith(OIDC_ROUTE_PREFIX)) {
    return failClosedWhenOidcIsUnconfigured(route.handler);
  }
  if (route.method === 'POST' && route.path === INVITE_ACCEPT_PATH) {
    return bindInviteToAuthenticatedIdentity(route.handler);
  }
  if (route.method === 'GET' && route.path === MEMBERS_PATH) {
    return redactPendingInviteTokens(route.handler);
  }
  return route.handler;
}

/**
 * Public ScopeWeave HTTP application.
 *
 * The protected-develop route graph remains in `application_routes.mjs`. This
 * entry point composes that graph while replacing its historical unsigned
 * Stripe stub with a fail-closed raw-body verification boundary. The composer
 * also closes protected-develop invite and unconfigured mock-OIDC privilege
 * boundaries. Copying route metadata preserves the original observability and
 * abuse-control middleware order.
 */
export const app = new Hono();

// Copy every shipped route and middleware except the historical unsigned Stripe
// handler. Security wrappers are applied at the same route positions so the
// existing rate-limit, authentication, RBAC, audit, and logging order remains
// authoritative rather than being bypassed by an earlier top-level endpoint.
for (const route of applicationRoutes.routes.filter(
  ({ method, path }) => !(method === 'POST' && path === '/api/stripe/webhook'),
)) {
  app.on(route.method, route.path, secureCopiedHandler(route));
}

app.post('/api/stripe/webhook', async (c) => {
  try {
    await verifyStripeWebhookRequest(c.req.raw, {
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });
    // Signature validity authenticates the delivery only. Until durable event
    // deduplication and provider-state reconciliation integrate, webhook JSON is
    // not authority to mutate orgs.plan or any other entitlement state.
    return c.json({ received: true }, 200, { 'Cache-Control': 'no-store' });
  } catch (error) {
    if (error instanceof StripeWebhookError) {
      return c.json({ error: error.code }, error.status, { 'Cache-Control': 'no-store' });
    }
    return c.json({ error: 'stripe_webhook_unavailable' }, 500, { 'Cache-Control': 'no-store' });
  }
});
