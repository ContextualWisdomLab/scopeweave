import { serve } from '@hono/node-server';
import { app } from './app.mjs';
import { clearfolioCapabilityStatus } from './clearfolio.mjs';

const port = Number(process.env.PORT) || 8787;
const clearfolioCapability = clearfolioCapabilityStatus();
console.log(JSON.stringify({
  event: 'capability.readiness',
  capability: 'clearfolio',
  ...clearfolioCapability,
}));
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ScopeWeave API listening on http://localhost:${info.port}`);
});
