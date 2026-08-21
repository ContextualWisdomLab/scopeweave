import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { readFile } from 'node:fs/promises';
import { app } from './app.mjs';

/**
 * Hono application served by the Node runtime.
 *
 * Keeping runtime-only static routes in an importable app lets API tests exercise
 * the exact deployment routing without importing the listener entrypoint and
 * accidentally opening a TCP port.
 */
export const runtimeApp = new Hono();

runtimeApp.use('/dialog-accessibility.js', secureHeaders());
runtimeApp.get('/dialog-accessibility.js', async (c) => {
  try {
    const body = await readFile(new URL('../dialog-accessibility.js', import.meta.url));
    return c.body(body, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  } catch (error) {
    if (error?.code === 'ENOENT') return c.notFound();
    return c.text('Internal Server Error', 500);
  }
});

runtimeApp.route('/', app);
