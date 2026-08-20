import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { app as applicationRoutes } from './application_routes.mjs';
import { normalizeBillingStatusResponse } from './billing_status_response.mjs';

const toastStylesheetUrl = new URL('../toast-state.css', import.meta.url);

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

// The internal billing route already derives name/price/limits from
// `planOf(org)`, but historically serialized `org.plan` as if it were the same
// authority. Normalize only successful billing responses at the public
// composition boundary so claim-backed authorization and buyer-visible status
// cannot disagree, while preserving the stored/manual value separately.
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

app.route('/', applicationRoutes);
