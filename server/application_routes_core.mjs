import { Hono } from 'hono';
import { app as implementationRoutes } from './application_routes_implementation.mjs';
import { canonicalEmail } from './db.mjs';

/**
 * Low-level ScopeWeave route graph with a fail-closed production OIDC boundary.
 *
 * Production OIDC is intentionally unavailable through this internal module.
 * Supported production consumers must enter through `application_routes.mjs`,
 * which validates issuer signatures and claims before creating a ScopeWeave
 * session. The legacy mock flow remains reachable only in explicit development
 * mode when no production issuer is configured.
 */
export const app = new Hono();

const GUARD_ACCOUNTING_METHOD = Symbol.for('scopeweave.guard_accounting.original_method');
const coreOidcMockEnabled =
  process.env.SCOPEWEAVE_DEV === '1' && !process.env.OIDC_ISSUER;

/**
 * Forward password-auth requests with one canonical mailbox identity.
 *
 * The implementation graph predates the invitation and production OIDC email
 * normalization contract. Canonicalizing at this low-level shared boundary
 * guarantees that signup duplicate checks, stored identities, login lookups,
 * workspace labels, and signed session claims all receive the same trimmed
 * NFC-normalized lowercase email. `db.mjs` separately migrates legacy rows and
 * enforces a canonical unique index, so direct database writes cannot recreate
 * a split identity.
 *
 * @param {import('hono').Context} c Current Hono request context.
 * @returns {Promise<Response>} Response from the implementation route graph.
 */
async function forwardCanonicalPasswordAuth(c) {
  const parsed = await c.req.json().catch(() => ({}));
  const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : {};
  const email = canonicalEmail(payload.email);
  const headers = new Headers(c.req.raw.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');

  return implementationRoutes.request(
    c.req.url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, email }),
    },
    c.env,
  );
}

/**
 * Reject direct production OIDC start/callback requests before legacy handlers.
 *
 * The supported wrapper uses a non-mutating OPTIONS probe carrying a private
 * symbol when a wrapper-level guard rejects a request. Forward only that probe
 * into the implementation graph so its request counters and structured logger
 * observe the rejection without reopening the legacy production OIDC handlers.
 *
 * @param {import('hono').Context} c Current Hono request context.
 * @param {() => Promise<void>} next Continues only for the development mock.
 * @returns {Promise<Response|void>} A non-cacheable 404 or downstream result.
 */
async function requireVerifiedOidcBoundary(c, next) {
  if (!coreOidcMockEnabled) {
    if (c.req.method === 'OPTIONS' && c.env?.[GUARD_ACCOUNTING_METHOD]) {
      return implementationRoutes.request(c.req.url, { method: 'OPTIONS' }, c.env);
    }
    return c.json(
      { error: 'sso not configured' },
      404,
      { 'Cache-Control': 'no-store' },
    );
  }
  return next();
}

app.post('/api/auth/signup', forwardCanonicalPasswordAuth);
app.post('/api/auth/login', forwardCanonicalPasswordAuth);
app.use('/api/auth/oidc/start', requireVerifiedOidcBoundary);
app.use('/api/auth/oidc/callback', requireVerifiedOidcBoundary);
app.route('/', implementationRoutes);
