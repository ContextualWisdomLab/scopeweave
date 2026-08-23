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
const webhookRegistrationEvidence = new WeakMap();
const STRIPE_WEBHOOK_PATH = '/api/stripe/webhook';

// The public app below owns the core's global logger/rate-limit middleware. The
// private replay app therefore contains only the route-specific registration
// chain (auth/RBAC + handler). That makes global accounting run exactly once and
// lets the public logger observe the facade's final response status instead of
// the side-effect-free probe used after an authorized body exceeds its budget.
// Route handlers are wrapped at their existing position so the bounded-body
// result is translated before the private route chain unwinds. Evidence remains
// process-local in a WeakMap keyed by the forwarded Request, so clients cannot
// spoof it.
const registrationCoreApp = new Hono();
let registrationRouteInstalled = false;
for (const route of coreApp.routes) {
  if (route.path !== WEBHOOK_REGISTRATION_PATH) continue;
  registrationRouteInstalled = true;
  registrationCoreApp.on(route.method, route.path, async (c, next) => {
    const response = await route.handler(c, next);
    if (webhookRegistrationEvidence.get(c.req.raw)?.tooLarge === true) {
      return c.json({ error: 'webhook registration body too large' }, 413);
    }
    return response;
  });
}
if (!registrationRouteInstalled) {
  throw new Error('ScopeWeave webhook registration core route is unavailable');
}

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
  // pull attacker-controlled bytes. Public global middleware has already run;
  // only the private route's auth/RBAC chain can reach c.req.json(), so body
  // consumption starts only for an authorized registration request. Once that
  // read begins, the facade enforces a small explicit memory budget before
  // decoding.
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
            // Feed the private core route a side-effect-free invalid registration
            // after auth/RBAC has already admitted this request. The wrapped route
            // translates that probe into the stable 413; the public logger then
            // records the same final status returned to the customer.
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
  // Public global middleware has already run exactly once. The zero-queue
  // forwarding stream then enters only the route-specific core chain, where
  // auth/RBAC can reject the request without draining attacker-controlled body
  // bytes. Bounded-body evidence is keyed to this Request in process memory, not
  // in an HTTP header.
  const { request, state } = requestWithCanonicalRegistration(c.req.raw);
  webhookRegistrationEvidence.set(request, state);
  let response;
  try {
    response = await registrationCoreApp.fetch(request);
  } finally {
    webhookRegistrationEvidence.delete(request);
    // Authentication/RBAC rejection can return without consuming the forwarding
    // body. Cancel that unread stream so its reader releases the original network
    // body instead of keeping the connection resource locked.
    if (request.body && !request.bodyUsed && !request.body.locked) {
      try { await request.body.cancel('webhook registration request completed'); } catch { /* best effort */ }
    }
  }
  return response;
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
 * The core route and middleware graph is preserved in registration order. Core
 * global middleware is mounted first so every public request, including the
 * registration facade and verified Stripe route, retains the same logging and
 * rate-limit envelope. The historical unsigned Stripe route is deliberately
 * omitted and replaced after those inherited global controls.
 */
export const app = new Hono();

// Global core middleware must wrap the registration facade as well as ordinary
// routes. Keeping it here (and out of registrationCoreApp) makes final response
// status, metrics, and limiter state line up with the public request exactly once.
for (const route of coreApp.routes.filter(({ path }) => path === '*')) {
  app.on(route.method, route.path, route.handler);
}

app.use(WEBHOOK_REGISTRATION_PATH, async (c, next) => {
  if (c.req.method !== 'POST') return next();
  return registrationPolicyResponse(c);
});

for (const route of coreApp.routes.filter(
  ({ method, path }) => (
    path !== '*'
    && !(method === 'POST' && path === STRIPE_WEBHOOK_PATH)
  ),
)) {
  app.on(route.method, route.path, route.handler);
}
app.post(STRIPE_WEBHOOK_PATH, stripeWebhookResponse);
