import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { app as applicationRoutes } from './application_routes.mjs';
import { configureBillingEntitlementDatabase } from './billing.mjs';
import { normalizeBillingStatusResponse } from './billing_status_response.mjs';
import { db } from './db.mjs';
import { stripeReconciliationRecoveryRoutes } from './stripe_reconciliation_recovery_routes.mjs';

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
 * `application_routes.mjs`. This entry point preserves protected public assets
 * and normalizes buyer-visible response contracts while the legacy route graph
 * is decomposed into dedicated modules.
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

// The internal billing route derives name/price/limits from `planOf(org)` while
// retaining the durable/manual value in its legacy `plan` field. Normalize only
// successful billing responses at the public composition boundary so the
// claim-backed authorization plan is buyer-visible and the stored value remains
// separately auditable.
app.use('/api/orgs/:id/billing', async (c, next) => {
  await next();
  if (c.res.status !== 200) return;

  const originalResponse = c.res;
  const normalized = normalizeBillingStatusResponse(await originalResponse.clone().json());
  const headers = new Headers(originalResponse.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=UTF-8');
  c.res = new Response(JSON.stringify(normalized), {
    status: originalResponse.status,
    headers,
  });
});

// Keep operator recovery isolated from the legacy monolith. This dedicated route
// module owns only tenant-scoped dead-letter inspection/retry and is mounted before
// the broader application graph so it cannot be shadowed by future catch-all routes.
app.route('/', stripeReconciliationRecoveryRoutes);
app.route('/', applicationRoutes);
