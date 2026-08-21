import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { readFile } from 'node:fs/promises';
import { app } from './app.mjs';

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

  runtimeApp.use('/dialog-accessibility.js', secureHeaders());
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
