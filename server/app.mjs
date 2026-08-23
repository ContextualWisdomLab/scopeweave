// ScopeWeave API security facade for outbound webhook registration.
// The protected-develop route graph lives in app_core.mjs; this module adds
// bounded fail-closed policies without rewriting tenant, auth, billing,
// attachment, Clearfolio, or project-planning behavior.
import { Hono } from 'hono';
import { app as coreApp } from './app_core.mjs';
import { StripeWebhookError, verifyStripeWebhookRequest } from './stripe_webhook.mjs';
import { validateWebhookRegistrationUrl } from './webhook_transport.mjs';

const WEBHOOK_REGISTRATION_PATH = '/api/orgs/:id/webhooks';
const WEBHOOK_REGISTRATION_BODY_MAX_BYTES = 16 * 1024;
const STRIPE_WEBHOOK_PATH = '/api/stripe/webhook';

function canonicalRegistrationUrl(value) {
  return validateWebhookRegistrationUrl(value, {
    allowDevelopmentLoopback: process.env.SCOPEWEAVE_DEV === '1',
  });
}

function canonicalRegistrationPayload(text) {
  let payload = {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) payload = value;
  } catch { /* malformed JSON follows the core route's stable 400 path */ }

  let canonicalUrl = '';
  try {
    canonicalUrl = canonicalRegistrationUrl(payload.url);
  } catch { /* the core registration route owns the stable destination error */ }

  return JSON.stringify({
    ...payload,
    url: canonicalUrl,
  });
}

function canonicalRegistrationBody(original) {
  const state = { tooLarge: false };
  if (!original.body) return { body: JSON.stringify({ url: '' }), state };

  const source = original.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let text = '';
  let totalBytes = 0;
  let finished = false;

  // A zero-sized queue is deliberate: creating the forwarding Request must not
  // pull attacker-controlled bytes. The core rate-limit/auth/RBAC middleware
  // therefore runs first; only its route-level c.req.json() read starts source
  // consumption for an already-authorized registration request. Once that read
  // begins, the facade enforces a small explicit memory budget before decoding.
  const body = new ReadableStream({
    async pull(controller) {
      if (finished) return;
      try {
        while (true) {
          const { done, value } = await source.read();
          if (done) {
            text += decoder.decode();
            controller.enqueue(encoder.encode(canonicalRegistrationPayload(text)));
            controller.close();
            finished = true;
            source.releaseLock();
            return;
          }

          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          totalBytes += chunk.byteLength;
          if (totalBytes > WEBHOOK_REGISTRATION_BODY_MAX_BYTES) {
            state.tooLarge = true;
            finished = true;
            try { await source.cancel('webhook registration body too large'); } catch { /* best effort */ }
            try { source.releaseLock(); } catch { /* cancellation may release it */ }
            // Feed the core route a side-effect-free invalid registration after
            // auth/RBAC has already admitted this request. The facade converts
            // that route response into the stable 413 below.
            controller.enqueue(encoder.encode(JSON.stringify({ url: '' })));
            controller.close();
            return;
          }
          text += decoder.decode(chunk, { stream: true });
        }
      } catch (error) {
        finished = true;
        try { source.releaseLock(); } catch { /* already released/cancelled */ }
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      try {
        await source.cancel(reason);
      } finally {
        try { source.releaseLock(); } catch { /* cancellation can release it */ }
      }
    },
  }, { highWaterMark: 0 });

  return { body, state };
}

function requestWithCanonicalRegistration(original) {
  const headers = new Headers(original.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  const { body, state } = canonicalRegistrationBody(original);
  return {
    request: new Request(original.url, {
      method: original.method,
      headers,
      body,
      signal: original.signal,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    }),
    state,
  };
}

async function registrationPolicyResponse(c) {
  // Route the request through the core exactly once. The forwarding stream has
  // no eager queue, so core rate-limit/auth/RBAC middleware can reject a request
  // without the facade draining an attacker-controlled body first.
  const { request, state } = requestWithCanonicalRegistration(c.req.raw);
  const response = await coreApp.fetch(request);
  if (!state.tooLarge) return response;
  return c.json({ error: 'webhook registration body too large' }, 413);
}

async function stripeWebhookResponse(c) {
  try {
    await verifyStripeWebhookRequest(c.req.raw, {
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });
    // Authentication of a provider delivery is not entitlement authority. A
    // later durable event ledger/provider-state reconciliation owns plan writes.
    return c.json({ received: true }, 200, { 'Cache-Control': 'no-store' });
  } catch (error) {
    if (error instanceof StripeWebhookError) {
      return c.json({ error: error.code }, error.status, { 'Cache-Control': 'no-store' });
    }
    return c.json({ error: 'stripe_webhook_unavailable' }, 500, { 'Cache-Control': 'no-store' });
  }
}

/**
 * Public ScopeWeave HTTP application with fail-closed webhook boundaries.
 *
 * The core route and middleware graph is preserved in registration order, but
 * the historical unsigned Stripe route is deliberately omitted from the public
 * graph and replaced after the inherited request logging/rate-limit middleware.
 * This makes unsigned plan escalation unreachable from the shipped server while
 * retaining the existing destination-registration facade and all other routes.
 */
export const app = new Hono();
app.use(WEBHOOK_REGISTRATION_PATH, async (c, next) => {
  if (c.req.method !== 'POST') return next();
  return registrationPolicyResponse(c);
});
for (const route of coreApp.routes.filter(
  ({ method, path }) => !(method === 'POST' && path === STRIPE_WEBHOOK_PATH),
)) {
  app.on(route.method, route.path, route.handler);
}
app.post(STRIPE_WEBHOOK_PATH, stripeWebhookResponse);
