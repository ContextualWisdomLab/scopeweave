// ScopeWeave API security facade for outbound webhook registration and delivery.
// The protected-develop route graph lives in app_core.mjs unchanged; this module
// adds one bounded fail-closed destination policy without rewriting tenant/auth,
// billing, attachment, Clearfolio, or project-planning behavior.
import { Hono } from 'hono';
import { app as coreApp } from './app_core.mjs';
import {
  postWebhook,
  validateWebhookRegistrationUrl,
} from './webhook_transport.mjs';

const WEBHOOK_REGISTRATION_PATH = '/api/orgs/:id/webhooks';
const webhookFetchBoundaryKey = Symbol.for('scopeweave.webhook-fetch-boundary');
const nativeFetch = globalThis.fetch.bind(globalThis);

function isSignedWebhookInput(input, init) {
  const requestInput = input instanceof Request ? input : null;
  const method = String(init?.method ?? requestInput?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? requestInput?.headers);
  return method === 'POST'
    && Boolean(headers.get('x-scopeweave-event'))
    && /^sha256=[0-9a-f]{64}$/i.test(
      headers.get('x-scopeweave-signature') || '',
    );
}

async function protectedWebhookFetch(input, init) {
  if (!isSignedWebhookInput(input, init)) return nativeFetch(input, init);
  const request = new Request(input, init);

  const body = request.body
    ? new Uint8Array(await request.clone().arrayBuffer())
    : '';
  const result = await postWebhook(request.url, {
    headers: Object.fromEntries(request.headers.entries()),
    body,
    signal: request.signal,
  });
  if (result.status >= 200 && result.status <= 599) {
    return new Response(null, { status: result.status });
  }
  return Response.error();
}

if (!globalThis[webhookFetchBoundaryKey]) {
  globalThis.fetch = protectedWebhookFetch;
  Object.defineProperty(globalThis, webhookFetchBoundaryKey, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
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
  } catch { /* the core legacy URL guard is translated after auth/authorization */ }

  return JSON.stringify({
    ...payload,
    url: canonicalUrl,
  });
}

function canonicalRegistrationBody(original) {
  if (!original.body) return JSON.stringify({ url: '' });

  const source = original.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let text = '';
  let finished = false;

  // A zero-sized queue is deliberate: creating the forwarding Request must not
  // pull attacker-controlled bytes. The core rate-limit/auth/RBAC middleware
  // therefore runs first; only its route-level c.req.json() read starts source
  // consumption for an already-authorized registration request.
  return new ReadableStream({
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
          text += decoder.decode(value, { stream: true });
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
}

function requestWithCanonicalRegistration(original) {
  const headers = new Headers(original.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  const body = canonicalRegistrationBody(original);
  return new Request(original.url, {
    method: original.method,
    headers,
    body,
    signal: original.signal,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
}

async function registrationPolicyResponse(c) {
  // Route the request through the core exactly once. The forwarding stream has
  // no eager queue, so core rate-limit/auth/RBAC middleware can reject a request
  // without the facade draining an attacker-controlled body first.
  const response = await coreApp.fetch(requestWithCanonicalRegistration(c.req.raw));
  if (response.status !== 400) return response;
  const responseBody = await response.clone().json().catch(() => null);
  if (responseBody?.error !== 'valid http(s) url required') return response;
  return c.json({ error: 'valid public https webhook URL required' }, 400);
}

/**
 * Public ScopeWeave HTTP application with fail-closed outbound webhook policy.
 * All non-registration routes are delegated unchanged to the protected-develop
 * core application; webhook POST registration is canonicalized before storage.
 */
export const app = new Hono();
app.use(WEBHOOK_REGISTRATION_PATH, async (c, next) => {
  if (c.req.method !== 'POST') return next();
  return registrationPolicyResponse(c);
});
app.route('/', coreApp);
