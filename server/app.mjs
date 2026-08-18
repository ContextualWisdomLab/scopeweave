// ScopeWeave API security facade.
//
// The historical Hono route graph remains in app_core.mjs so this bounded
// security repair can interpose one explicit outbound-webhook policy boundary
// without rewriting unrelated tenant, auth, billing, or Clearfolio behavior.
import { app as coreApp } from './app_core.mjs';
import {
  WebhookDestinationError,
  postWebhook,
  validateWebhookRegistrationUrl,
} from './webhook_transport.mjs';

const nativeFetch = globalThis.fetch.bind(globalThis);
const webhookFetchBoundaryKey = Symbol.for('scopeweave.webhook-fetch-boundary');
const WEBHOOK_REGISTRATION_PATH = /^\/api\/orgs\/[^/]+\/webhooks$/;

function normalizedHeaders(headers) {
  try {
    return new Headers(headers || {});
  } catch {
    return new Headers();
  }
}

function isSignedWebhookRequest(init) {
  if (String(init?.method || '').toUpperCase() !== 'POST') return false;
  const headers = normalizedHeaders(init?.headers);
  return Boolean(
    headers.get('x-scopeweave-event')
      && /^sha256=[0-9a-f]{64}$/i.test(headers.get('x-scopeweave-signature') || ''),
  );
}

// Install exactly once per process. Only the server's own signed webhook POSTs
// are routed through the SSRF-safe transport; OIDC, Clearfolio, billing, and
// all other fetch users retain the native implementation.
if (!globalThis[webhookFetchBoundaryKey]) {
  globalThis.fetch = (input, init = {}) => {
    if (!isSignedWebhookRequest(init)) return nativeFetch(input, init);
    const headers = normalizedHeaders(init.headers);
    return postWebhook(input instanceof Request ? input.url : input, {
      headers: Object.fromEntries(headers.entries()),
      body: init.body ?? '',
      signal: init.signal,
    });
  };
  Object.defineProperty(globalThis, webhookFetchBoundaryKey, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function isDevelopmentLoopbackHttp(value) {
  if (process.env.SCOPEWEAVE_DEV !== '1') return false;
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return url.protocol === 'http:'
      && !url.username
      && !url.password
      && !url.hash
      && (host === 'localhost' || host === '127.0.0.1' || host === '::1');
  } catch {
    return false;
  }
}

async function registrationPolicyResponse(request) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || !WEBHOOK_REGISTRATION_PATH.test(url.pathname)) {
    return null;
  }
  const payload = await request.clone().json().catch(() => ({}));
  try {
    validateWebhookRegistrationUrl(payload.url);
    return null;
  } catch (error) {
    // Preserve the existing dev-only localhost failure-path smoke fixture. The
    // outbound transport still refuses HTTP, so this exception cannot create a
    // server-side connection and production never inherits it.
    if (error instanceof WebhookDestinationError && isDevelopmentLoopbackHttp(payload.url)) {
      return null;
    }
    return Response.json({ error: 'valid public https webhook URL required' }, { status: 400 });
  }
}

async function secureFetch(request, ...rest) {
  const denied = await registrationPolicyResponse(request);
  if (denied) return denied;
  return coreApp.fetch(request, ...rest);
}

async function secureRequest(input, init) {
  const request = input instanceof Request
    ? input
    : new Request(new URL(String(input), 'http://localhost'), init);
  return secureFetch(request);
}

// Proxying preserves Hono route/introspection properties for existing callers
// while forcing both server fetches and in-process app.request tests through the
// registration policy above.
export const app = new Proxy(coreApp, {
  get(target, property) {
    if (property === 'fetch') return secureFetch;
    if (property === 'request') return secureRequest;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
