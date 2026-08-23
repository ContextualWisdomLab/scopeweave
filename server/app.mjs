import { Hono } from 'hono';
import { app as applicationRoutes } from './application_routes.mjs';
import { StripeWebhookError, verifyStripeWebhookRequest } from './stripe_webhook.mjs';

/**
 * Public ScopeWeave HTTP application.
 *
 * The protected-develop route graph remains byte-for-byte in
 * `application_routes.mjs`. This entry point owns the emergency Stripe webhook
 * trust boundary so unsigned provider-shaped JSON cannot reach the historical
 * entitlement mutation while the full durable #488 reconciliation stack is
 * still integrating. All unrelated routes delegate unchanged.
 */
export const app = new Hono();

// Keep the shipped cloud-toast asset on the public entry path while delegating
// its existing implementation to the protected route graph.
app.get('/toast-state.css', (c) => applicationRoutes.fetch(c.req.raw));

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

app.route('/', applicationRoutes);
