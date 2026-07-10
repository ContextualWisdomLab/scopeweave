import { serve } from '@hono/node-server';
import { app } from './app.mjs';
import { config } from './config.mjs';

const port = config.server.port;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ScopeWeave API listening on http://localhost:${info.port}`);
});
