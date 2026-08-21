import process from 'node:process';
import { serve } from '@hono/node-server';
import { app } from './app.mjs';
import { reconcileNextStripeBillingTrigger } from './db.mjs';
import { bindScopeWeaveRuntime } from './server_runtime.mjs';
import {
  createStripeReconciliationScheduler,
  stripeReconciliationPollIntervalMs,
} from './stripe_reconciliation_scheduler.mjs';

const port = Number(process.env.PORT) || 8787;
const reconciliationScheduler = createStripeReconciliationScheduler({
  runOnce: reconcileNextStripeBillingTrigger,
  intervalMs: stripeReconciliationPollIntervalMs(
    process.env.SCOPEWEAVE_STRIPE_RECONCILIATION_POLL_MS,
  ),
  onFailure: (code) => console.error(code),
});
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ScopeWeave API listening on http://localhost:${info.port}`);
});

bindScopeWeaveRuntime({
  server,
  scheduler: reconciliationScheduler,
  onShutdownFailure: (code) => {
    console.error(code);
    process.exitCode = 1;
  },
});
