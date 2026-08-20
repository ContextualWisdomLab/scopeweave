import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { app as applicationRoutes } from './application_routes.mjs';
import { configureBillingEntitlementDatabase } from './billing.mjs';
import { db } from './db.mjs';

const toastStylesheetUrl = new URL('../toast-state.css', import.meta.url);

// Bind the already-bootstrapped server-owned database before the public route
// graph can serve any request that reports plan authority. This keeps legacy
// synchronous planOf consumers aligned with the same tenant-scoped current
// entitlement claims used by resource-limit authorization, without mutating
// orgs.plan or accepting caller-selected claim identities.
configureBillingEntitlementDatabase(db);

/**
 * ScopeWeave's public HTTP application entry point.
 *
 * The large application route graph remains isolated in
 * `application_routes.mjs`. This entry point restores the protected shipped
 * toast stylesheet before mounting those routes, so the webhook trust-boundary
 * slice cannot delete customer-visible accessibility feedback while it replaces
 * the legacy Stripe webhook handler.
 */
export const app = new Hono();

app.get('/toast-state.css', async (c) => {
  try {
    const stylesheet = await readFile(toastStylesheetUrl, 'utf8');
    return c.body(stylesheet, 200, {
      'Content-Type': 'text/css; charset=utf-8',
    });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

app.route('/', applicationRoutes);
