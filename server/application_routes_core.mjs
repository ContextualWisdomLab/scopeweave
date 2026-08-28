import { Hono } from 'hono';
import { app as implementationRoutes } from './application_routes_implementation.mjs';

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

const coreOidcMockEnabled =
  process.env.SCOPEWEAVE_DEV === '1' && !process.env.OIDC_ISSUER;

/**
 * Reject direct production OIDC start/callback requests before legacy handlers.
 *
 * @param {import('hono').Context} c Current Hono request context.
 * @param {() => Promise<void>} next Continues only for the development mock.
 * @returns {Promise<Response|void>} A non-cacheable 404 or downstream result.
 */
async function requireVerifiedOidcBoundary(c, next) {
  if (!coreOidcMockEnabled) {
    return c.json(
      { error: 'sso not configured' },
      404,
      { 'Cache-Control': 'no-store' },
    );
  }
  return next();
}

app.use('/api/auth/oidc/start', requireVerifiedOidcBoundary);
app.use('/api/auth/oidc/callback', requireVerifiedOidcBoundary);
app.route('/', implementationRoutes);
