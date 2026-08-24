// ScopeWeave API security facade for outbound webhook registration.
// The protected-develop route graph lives in app_core.mjs; this module adds
// bounded fail-closed policies without rewriting tenant, auth, billing,
// attachment, Clearfolio, or project-planning behavior.
import { Hono } from 'hono';
import { app as coreApp } from './app_core.mjs';
import { db } from './db.mjs';
import { StripeWebhookError, verifyStripeWebhookRequest } from './stripe_webhook.mjs';
import { validateWebhookRegistrationUrl } from './webhook_transport.mjs';

const WEBHOOK_REGISTRATION_PATH = '/api/orgs/:id/webhooks';
const WEBHOOK_REGISTRATION_BODY_MAX_BYTES = 16 * 1024;
const webhookRegistrationEvidence = new WeakMap();
const STRIPE_WEBHOOK_PATH = '/api/stripe/webhook';
const STRIPE_CHECKOUT_AUDIT_ACTION = 'billing.checkout_completed';
const STRIPE_EVENT_TARGET_TYPE = 'stripe_event';
const STRIPE_ENTITLEMENT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);
const POSITIVE_DECIMAL_ID = /^[1-9]\d*$/;

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

/**
 * Resolve the ScopeWeave organization bound to a verified paid subscription checkout.
 *
 * ScopeWeave creates Stripe Checkout sessions with both client_reference_id and
 * metadata.orgId set to the same server-selected organization identifier. Both
 * fields must therefore be present, canonical positive integers, and equal. The
 * checkout must also report subscription mode and a paid status before either
 * the immediate completion event or Stripe's delayed-payment success event can
 * become entitlement authority. Provider-shaped but inconsistent or unpaid
 * events are acknowledged without mutating tenant state.
 */
function checkoutOrganizationId(event) {
  if (!STRIPE_ENTITLEMENT_EVENTS.has(event?.type)) return null;
  const checkout = event?.data?.object;
  if (
    !checkout
    || typeof checkout !== 'object'
    || checkout.mode !== 'subscription'
    || checkout.payment_status !== 'paid'
  ) return null;

  const referenceId = checkout.client_reference_id;
  const metadataId = checkout.metadata?.orgId;
  if (
    typeof referenceId !== 'string'
    || typeof metadataId !== 'string'
    || !POSITIVE_DECIMAL_ID.test(referenceId)
    || !POSITIVE_DECIMAL_ID.test(metadataId)
    || referenceId !== metadataId
  ) return null;

  const orgId = Number(referenceId);
  return Number.isSafeInteger(orgId) ? orgId : null;
}

/**
 * Project one verified Stripe checkout into ScopeWeave entitlement state once.
 *
 * The existing append-only audit_log is also the durable provider-event ledger:
 * a BEGIN IMMEDIATE transaction serializes duplicate deliveries, checks the
 * globally unique Stripe event id before any plan write, updates only an existing
 * organization, and records the event id without secrets or provider payloads.
 * Replayed deliveries are acknowledged but cannot create a second entitlement
 * transition or audit record.
 */
function reconcileStripeCheckout(event) {
  const orgId = checkoutOrganizationId(event);
  if (orgId === null) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    const alreadyProcessed = db.prepare(`
      SELECT id
      FROM audit_log
      WHERE action = ? AND target_type = ? AND target_id = ?
      LIMIT 1
    `).get(STRIPE_CHECKOUT_AUDIT_ACTION, STRIPE_EVENT_TARGET_TYPE, event.id);

    if (!alreadyProcessed) {
      const org = db.prepare('SELECT id FROM orgs WHERE id = ?').get(orgId);
      if (org) {
        db.prepare("UPDATE orgs SET plan = 'pro' WHERE id = ?").run(orgId);
        db.prepare(`
          INSERT INTO audit_log(org_id,user_id,action,target_type,target_id,meta)
          VALUES(?,NULL,?,?,?,?)
        `).run(
          orgId,
          STRIPE_CHECKOUT_AUDIT_ACTION,
          STRIPE_EVENT_TARGET_TYPE,
          event.id,
          JSON.stringify({ provider: 'stripe', eventType: event.type, plan: 'pro' }),
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the reconciliation failure */ }
    throw error;
  }
}

async function stripeWebhookResponse(c) {
  try {
    const event = await verifyStripeWebhookRequest(c.req.raw, {
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });
    reconcileStripeCheckout(event);
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

// Hono normalizes root `*` registrations to `/*` in `routes`. Identify only the
// method-ALL records produced by core `app.use('*', ...)`; the final GET `/*`
// static fallback is a route, not middleware, and must keep its original tail
// position. Re-registering these records before the facade makes the core logger
// and optional rate limiter wrap registration POSTs instead of being replayed
// after the short-circuiting facade.
const isGlobalCoreMiddleware = ({ method, path }) => method === 'ALL' && path === '/*';
for (const route of coreApp.routes.filter(isGlobalCoreMiddleware)) {
  app.use(route.path, route.handler);
}

app.use(WEBHOOK_REGISTRATION_PATH, async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const response = await registrationPolicyResponse(c);
  // Assign the facade's final response before outer global middleware resumes.
  // Hono's access logger reads c.res after await next(), so merely returning the
  // replacement Response can leave it observing the private probe's 400 status.
  c.res = response;
  return response;
});

for (const route of coreApp.routes.filter(
  (route) => (
    !isGlobalCoreMiddleware(route)
    && !(route.method === 'POST' && route.path === STRIPE_WEBHOOK_PATH)
  ),
)) {
  app.on(route.method, route.path, route.handler);
}
app.post(STRIPE_WEBHOOK_PATH, stripeWebhookResponse);
