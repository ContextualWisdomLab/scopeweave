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

function requestWithJson(original, payload) {
  const headers = new Headers(original.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return new Request(original.url, {
    method: original.method,
    headers,
    body: JSON.stringify(payload),
    signal: original.signal,
  });
}

async function registrationPayload(request) {
  try {
    const value = JSON.parse(await request.text());
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function registrationPolicyResponse(c) {
  const payload = await registrationPayload(c.req.raw);
  let canonicalUrl;
  try {
    canonicalUrl = canonicalRegistrationUrl(payload.url);
  } catch {
    // Preserve the core route's authentication/rate-limit/tenant precedence by
    // executing exactly one side-effect-free invalid-registration request. An
    // authorized manager deterministically reaches the legacy URL guard (400);
    // all earlier 401/403/429 outcomes are returned unchanged.
    const probe = await coreApp.fetch(requestWithJson(c.req.raw, {
      url: '',
      events: payload.events,
    }));
    if (probe.status !== 400) return probe;
    const probeBody = await probe.clone().json().catch(() => null);
    if (probeBody?.error !== 'valid http(s) url required') return probe;
    return c.json({ error: 'valid public https webhook URL required' }, 400);
  }

  return coreApp.fetch(requestWithJson(c.req.raw, {
    ...payload,
    url: canonicalUrl,
  }));
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
