import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { readFile } from 'node:fs/promises';
import { app } from './app.mjs';

const runtimeApp = new Hono();

runtimeApp.use('/dialog-accessibility.js', secureHeaders());
runtimeApp.get('/dialog-accessibility.js', async (c) => {
  try {
    const body = await readFile(new URL('../dialog-accessibility.js', import.meta.url));
    return c.body(body, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  } catch {
    return c.notFound();
  }
});
runtimeApp.route('/', app);

const port = Number(process.env.PORT) || 8787;
serve({ fetch: runtimeApp.fetch, port }, (info) => {
  console.log(`ScopeWeave API listening on http://localhost:${info.port}`);
});
