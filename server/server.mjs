import { serve } from '@hono/node-server';
import { runtimeApp } from './runtime-app.mjs';

const port = Number(process.env.PORT) || 8787;
serve({ fetch: runtimeApp.fetch, port }, (info) => {
  console.log(`ScopeWeave API listening on http://localhost:${info.port}`);
});
