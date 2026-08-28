// Security envelope for the ScopeWeave SaaS routes.
//
// The supported shared route graph also serves direct consumers, but the public
// Node entrypoint must remain authoritative for its own transport peer. Both
// boundaries therefore consume the same rate-limit module; the nested shared
// instance is initialized disabled here so one request cannot acquire two
// independent limiter buckets or observability deltas.
import { Hono } from 'hono';
import {
  createRateLimitMiddleware,
  createRateLimitObservability,
} from './rate_limit.mjs';

const configuredRateLimitMax = process.env.SCOPEWEAVE_RATE_LIMIT_MAX;

// app_routes.mjs is a compatibility re-export of application_routes.mjs. That
// boundary imports application_routes_core.mjs, which uses the same shared
// limiter. Load the nested graph with limiting disabled, then restore the
// operator value before constructing the public transport-peer-aware limiter
// below. Restoring the environment does not reactivate the nested limiter.
let routeApp;
try {
  process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '0';
  ({ app: routeApp } = await import('./app_routes.mjs'));
} finally {
  if (configuredRateLimitMax === undefined) delete process.env.SCOPEWEAVE_RATE_LIMIT_MAX;
  else process.env.SCOPEWEAVE_RATE_LIMIT_MAX = configuredRateLimitMax;
}

export const app = new Hono();

const rateLimitObservability = createRateLimitObservability();
app.use('*', createRateLimitMiddleware(rateLimitObservability));
app.route('/', routeApp);
