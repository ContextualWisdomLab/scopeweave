// Security envelope for the ScopeWeave SaaS routes.
//
// The supported shared route graph also serves direct consumers, but the public
// Node entrypoint must remain authoritative for its own transport peer. Both
// boundaries therefore consume the same rate-limit module. The shared runtime
// context marker makes the nested limiter a no-op after the public boundary has
// admitted a request, so the shared route graph can remain correctly configured
// when it is later reused directly from the same module cache.
import { Hono } from 'hono';
import {
  createRateLimitMiddleware,
  createRateLimitObservability,
} from './rate_limit.mjs';

// app_routes.mjs is a compatibility re-export of application_routes.mjs. Keep
// that supported shared boundary configured with the operator's real rate-limit
// policy; createRateLimitMiddleware deduplicates the nested mounted middleware
// through its Hono context marker instead of mutating process-global config
// during module evaluation.
const { app: routeApp } = await import('./app_routes.mjs');

export const app = new Hono();

const rateLimitObservability = createRateLimitObservability();
app.use('*', createRateLimitMiddleware(rateLimitObservability));
app.route('/', routeApp);