import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { readFile } from 'node:fs/promises';
import { app } from './app.mjs';

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
  strictTransportSecurity: 'max-age=15552000; includeSubDomains',
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
 * The optional file reader keeps runtime-only static routes testable without
 * importing the listener entrypoint or opening a TCP port. Production callers
 * use Node's `readFile`; tests may inject a reader to reproduce I/O failures.
 *
 * @param {{readStaticFile?: typeof readFile}} [options] Runtime dependencies.
 * @returns {Hono} A fresh runtime application with static and API routes.
 */
export function createRuntimeApp({ readStaticFile = readFile } = {}) {
  const runtimeApp = new Hono();

  runtimeApp.use('*', secureHeaders(SECURE_HEADERS_OPTIONS));
  runtimeApp.get('/dialog-accessibility.js', async (c) => {
    try {
      const body = await readStaticFile(new URL('../dialog-accessibility.js', import.meta.url));
      return c.body(body, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    } catch (error) {
      if (error?.code === 'ENOENT') return c.notFound();
      return c.text('Internal Server Error', 500);
    }
  });

  runtimeApp.route('/', app);
  return runtimeApp;
}

/** Hono application used by the production Node listener. */
export const runtimeApp = createRuntimeApp();
