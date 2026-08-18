// ScopeWeave API security facade.
//
// The historical Hono route graph remains in app_core.mjs so bounded security
// policy can be added without rewriting unrelated tenant, auth, billing, or
// Clearfolio behavior. Every production server and in-process caller imports
// this facade; app_core.mjs is an implementation module, not a public entrypoint.
import { app as coreApp } from './app_core.mjs';
import {
  WebhookDestinationError,
  postWebhook,
  validateWebhookRegistrationUrl,
} from './webhook_transport.mjs';

const nativeFetch = globalThis.fetch.bind(globalThis);
const webhookFetchBoundaryKey = Symbol.for('scopeweave.webhook-fetch-boundary');
const WEBHOOK_REGISTRATION_PATH = /^\/api\/orgs\/[^/]+\/webhooks$/;
const AUDIT_PATH = /^\/api\/orgs\/[^/]+\/audit$/;
const AUTH_EMAIL_PATH = /^\/api\/auth\/(?:signup|login)$/;
const OIDC_TOKEN_URL = process.env.OIDC_ISSUER
  ? `${process.env.OIDC_ISSUER.replace(/\/$/, '')}/token`
  : null;
const OIDC_TOKEN_TIMEOUT_MS = 3000;

function isSignedWebhookRequest(request) {
  if (request.method.toUpperCase() !== 'POST') return false;
  return Boolean(
    request.headers.get('x-scopeweave-event')
      && /^sha256=[0-9a-f]{64}$/i.test(
        request.headers.get('x-scopeweave-signature') || '',
      ),
  );
}

function isOidcTokenRequest(request) {
  return OIDC_TOKEN_URL !== null
    && request.method.toUpperCase() === 'POST'
    && request.url === OIDC_TOKEN_URL;
}

async function protectedWebhookFetch(request) {
  const body = request.body
    ? new Uint8Array(await request.clone().arrayBuffer())
    : '';
  const result = await postWebhook(request.url, {
    headers: Object.fromEntries(request.headers.entries()),
    body,
    signal: request.signal,
  });
  // Preserve fetch's Response contract for callers. Informational/invalid
  // status codes cannot construct a standard Response and are represented as a
  // network-style error response instead of leaking a transport-only object.
  if (result.status >= 200 && result.status <= 599) {
    return new Response(null, { status: result.status });
  }
  return Response.error();
}

function boundedOidcFetch(request) {
  return nativeFetch(new Request(request, {
    signal: AbortSignal.timeout(OIDC_TOKEN_TIMEOUT_MS),
  }));
}

// Install exactly once per process. The server's signed webhook POSTs are
// routed through the SSRF-safe transport, and the configured OIDC token exchange
// gets a bounded provider budget. Clearfolio, billing, and unrelated fetch users
// retain native fetch semantics. Constructing an effective Request first makes
// Request-object inputs and init overrides follow the same security decision as
// URL+init calls.
if (!globalThis[webhookFetchBoundaryKey]) {
  globalThis.fetch = async (input, init = undefined) => {
    const effectiveRequest = new Request(input, init);
    if (isSignedWebhookRequest(effectiveRequest)) {
      return protectedWebhookFetch(effectiveRequest);
    }
    if (isOidcTokenRequest(effectiveRequest)) {
      return boundedOidcFetch(effectiveRequest);
    }
    return nativeFetch(effectiveRequest);
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

function requestWithJson(request, payload) {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return new Request(request, {
    headers,
    body: JSON.stringify(payload),
  });
}

async function canonicalInboundRequest(request) {
  const url = new URL(request.url);

  if (request.method === 'POST' && AUTH_EMAIL_PATH.test(url.pathname)) {
    const payload = await request.clone().json().catch(() => null);
    if (
      payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && typeof payload.email === 'string'
    ) {
      const email = payload.email.trim().toLowerCase();
      if (email !== payload.email) return requestWithJson(request, { ...payload, email });
    }
  }

  if (request.method === 'GET' && AUDIT_PATH.test(url.pathname)) {
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null) {
      const requested = Number(rawLimit);
      const limit = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), 500)
        : 100;
      if (String(limit) !== rawLimit) {
        url.searchParams.set('limit', String(limit));
        return new Request(url, request);
      }
    }
  }

  return request;
}

/**
 * Ask the existing route graph to run its real authentication, tenant-role,
 * rate-limit, and request middleware before this facade returns a policy error.
 * The deliberately empty URL reaches the old route's own URL validation but can
 * never be persisted or delivered, so denied destinations do not bypass or
 * reorder the authoritative authorization boundary.
 */
async function deniedRegistrationAuthorization(request, rest) {
  const probe = requestWithJson(request, { url: '' });
  const response = await coreApp.fetch(probe, ...rest);
  if (response.status !== 400) return response;
  const payload = await response.clone().json().catch(() => null);
  return payload?.error === 'valid http(s) url required' ? null : response;
}

function canonicalRegistrationRequest(request, payload, canonicalUrl) {
  return requestWithJson(request, { ...payload, url: canonicalUrl });
}

async function registrationPolicyResult(request, rest) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || !WEBHOOK_REGISTRATION_PATH.test(url.pathname)) {
    return null;
  }
  const payload = await request.clone().json().catch(() => ({}));
  try {
    const canonicalUrl = validateWebhookRegistrationUrl(payload.url);
    return canonicalUrl === payload.url
      ? { request }
      : { request: canonicalRegistrationRequest(request, payload, canonicalUrl) };
  } catch (error) {
    // Preserve the existing dev-only localhost failure-path smoke fixture. The
    // outbound transport still refuses HTTP, so this exception cannot create a
    // server-side connection and production never inherits it.
    if (
      error instanceof WebhookDestinationError
      && isDevelopmentLoopbackHttp(payload.url)
    ) {
      return { request };
    }
    const authorization = await deniedRegistrationAuthorization(request, rest);
    if (authorization) return { response: authorization };
    return {
      response: Response.json(
        { error: 'valid public https webhook URL required' },
        { status: 400 },
      ),
    };
  }
}

async function secureFetch(request, ...rest) {
  const canonicalRequest = await canonicalInboundRequest(request);
  const policy = await registrationPolicyResult(canonicalRequest, rest);
  if (policy?.response) return policy.response;
  return coreApp.fetch(policy?.request || canonicalRequest, ...rest);
}

async function secureRequest(input, init, ...rest) {
  const request = input instanceof Request
    ? new Request(input, init)
    : new Request(new URL(String(input), 'http://localhost'), init);
  return secureFetch(request, ...rest);
}

// Proxying preserves Hono route/introspection properties for existing callers
// while forcing both server fetches and in-process app.request tests through the
// registration, identity, and request-boundary policies above.
export const app = new Proxy(coreApp, {
  get(target, property) {
    if (property === 'fetch') return secureFetch;
    if (property === 'request') return secureRequest;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
