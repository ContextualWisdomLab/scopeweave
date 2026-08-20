import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { app as applicationRoutes } from './application_routes.mjs';
import { configureBillingEntitlementDatabase } from './billing.mjs';
import { normalizeBillingStatusResponse } from './billing_status_response.mjs';
import {
  db,
  stripeEntitlementClaims,
  stripeInvoiceObservations,
  stripeSubscriptionObservations,
} from './db.mjs';
import { reconcileStripeBillingAuthoritatively } from './stripe_billing_reconciliation.mjs';
import { StripeWebhookError, verifyStripeWebhookRequest } from './stripe_webhook.mjs';
import {
  StripeWebhookReconciliationTriggerError,
  triggerStripeBillingReconciliationFromVerifiedEvent,
} from './stripe_webhook_reconciliation_trigger.mjs';

const toastStylesheetUrl = new URL('../toast-state.css', import.meta.url);
const checkoutSessionAuthorityStatement = db.prepare(`
  SELECT organization_id AS organizationId, provider_session_id AS providerSessionId
  FROM billing_checkout_attempts
  WHERE provider_session_id = ? AND attempt_state = 'provider_succeeded'
  LIMIT 2
`);
const subscriptionAuthorityStatement = db.prepare(`
  SELECT c.organization_id AS organizationId, s.subscription_id AS subscriptionId
  FROM billing_stripe_subscriptions s
  JOIN billing_stripe_customers c ON c.customer_id = s.customer_id
  WHERE s.subscription_id = ?
  LIMIT 1
`);

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
 * `application_routes.mjs`. This entry point preserves protected public assets,
 * owns cross-module billing composition, and normalizes buyer-visible response
 * contracts while the legacy route graph is decomposed into dedicated modules.
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

// Stripe event payloads are authenticated evidence, never tenant or entitlement
// authority. The signed Checkout Session ID can bootstrap the first Subscription
// binding only through a successful local Checkout attempt. Later Subscription
// and Invoice events resolve tenant authority through normalized local Stripe
// identity tables, then current provider reads drive the durable claim decision.
app.post('/api/stripe/webhook', async (c) => {
  let event;
  try {
    ({ event } = await verifyStripeWebhookRequest(c.req.raw, {
      secret: process.env.STRIPE_WEBHOOK_SECRET,
      includeEvidence: true,
    }));
  } catch (error) {
    if (error instanceof StripeWebhookError) {
      return c.json({ error: error.code }, error.status, { 'Cache-Control': 'no-store' });
    }
    return c.json({ error: 'stripe_webhook_unavailable' }, 500, { 'Cache-Control': 'no-store' });
  }

  try {
    await triggerStripeBillingReconciliationFromVerifiedEvent({
      event,
      resolveCheckoutSessionAuthority: (sessionId) => {
        const rows = checkoutSessionAuthorityStatement.all(sessionId);
        if (rows.length === 0) return null;
        if (rows.length !== 1) return {};
        return rows[0];
      },
      resolveSubscriptionAuthority: (subscriptionId) =>
        subscriptionAuthorityStatement.get(subscriptionId) || null,
      reconcileBilling: (input) => reconcileStripeBillingAuthoritatively({
        ...input,
        subscriptionRepository: stripeSubscriptionObservations,
        invoiceRepository: stripeInvoiceObservations,
        claimRepository: stripeEntitlementClaims,
      }),
    });
    return c.json({ received: true }, 200, { 'Cache-Control': 'no-store' });
  } catch (error) {
    if (error instanceof StripeWebhookReconciliationTriggerError) {
      return c.json({ error: error.code }, error.status, { 'Cache-Control': 'no-store' });
    }
    return c.json(
      { error: 'stripe_webhook_reconciliation_unavailable' },
      503,
      { 'Cache-Control': 'no-store' },
    );
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

app.route('/', applicationRoutes);
