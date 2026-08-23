import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { app } from './app.mjs';

const HSTS_MAX_AGE_SECONDS = 15552000;

/**
 * Build the Strict-Transport-Security value for the verified deployment scope.
 *
 * Host-only HSTS is the safe default for custom or shared deployment domains.
 * Descendant hosts are included only after the operator explicitly confirms
 * that every current and future subdomain is HTTPS-capable.
 *
 * @param {boolean} [includeSubDomains=false] Whether HSTS may cover descendant hosts.
 * @returns {string} The application-owned Strict-Transport-Security header value.
 */
export function strictTransportSecurityValue(includeSubDomains = false) {
  const hostOnly = `max-age=${HSTS_MAX_AGE_SECONDS}`;
  return includeSubDomains ? `${hostOnly}; includeSubDomains` : hostOnly;
}

/**
 * Security-sensitive response header policy owned by the ScopeWeave runtime.
 *
 * Declaring these values explicitly keeps customer-visible protections stable
 * across compatible Hono upgrades instead of inheriting mutable framework
 * defaults. Content Security Policy remains owned by the static document.
 */
export const SECURE_HEADERS_OPTIONS = Object.freeze({
  crossOriginResourcePolicy: 'same-origin',
  crossOriginOpenerPolicy: 'same-origin',
  referrerPolicy: 'no-referrer',
  strictTransportSecurity: strictTransportSecurityValue(
    process.env.SCOPEWEAVE_HSTS_INCLUDE_SUBDOMAINS === '1',
  ),
  xContentTypeOptions: 'nosniff',
  xDnsPrefetchControl: 'off',
  xDownloadOptions: 'noopen',
  xFrameOptions: 'SAMEORIGIN',
  xPermittedCrossDomainPolicies: 'none',
  xXssProtection: '0',
});

/**
 * Build the Hono application served by the Node runtime.
 *
 * Route ownership stays in the canonical application. The runtime adds only
 * deployment-wide response headers, then delegates every path to that
 * application. Tests may inject a small application to verify this boundary
 * without opening a TCP listener or duplicating production route logic.
 *
 * @param {{application?: Hono}} [options] Runtime dependencies.
 * @returns {Hono} A fresh runtime application with security headers and delegated routes.
 */
export function createRuntimeApp({ application = app } = {}) {
  const runtimeApp = new Hono();

  runtimeApp.use('*', secureHeaders(SECURE_HEADERS_OPTIONS));
  runtimeApp.route('/', application);
  return runtimeApp;
}

/** Hono application used by the production Node listener. */
export const runtimeApp = createRuntimeApp();
