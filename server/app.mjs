import { Hono } from 'hono';
import { app as applicationRoutes } from './application_routes.mjs';
import { StripeWebhookError, verifyStripeWebhookRequest } from './stripe_webhook.mjs';

/**
 * Public ScopeWeave HTTP application.
 *
 * The protected-develop route graph remains in `application_routes.mjs`. This
 * entry point composes that graph while replacing its historical unsigned
 * Stripe stub with a fail-closed raw-body verification boundary. Copying the
 * existing route metadata preserves the original observability and abuse-
 * control middleware order for every public route, including Stripe.
 */
export const app = new Hono();

// Keep the shipped cloud-toast asset on the public entry path while delegating
// its existing implementation to the protected route graph.
app.get('/toast-state.css', (c) => applicationRoutes.fetch(c.req.raw));

// Copy every shipped route and middleware except the historical unsigned Stripe
// handler. Registering the authenticated replacement after this copy keeps the
// original logging/metrics and rate-limit middleware ahead of the endpoint and
// makes the insecure handler absent from the public route graph rather than
// merely shadowed by registration order.
for (const route of applicationRoutes.routes.filter(
  ({ method, path }) => !(method === 'POST' && path === '/api/stripe/webhook'),
)) {
  app.on(route.method, route.path, route.handler);
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
