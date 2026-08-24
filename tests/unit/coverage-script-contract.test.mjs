// This contract prevents a subtle CI regression: the central review gate may
// invoke `test:coverage` directly, so that script itself must create Istanbul
// JSON rather than merely execute tests without instrumentation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const scripts = packageJson.scripts;

assert.equal(
  scripts.coverage,
  'npm run test:coverage',
  'the public coverage command delegates to the canonical coverage producer',
);
assert.match(
  scripts['test:coverage'],
  /\bc8\b.*--reporter=json(?![-\w]).*npm run test:coverage:cases/,
  'test:coverage creates Istanbul JSON before executing coverage cases',
);
assert.match(
  scripts['test:coverage'],
  /--reporter=json-summary\b/,
  'test:coverage also creates the Istanbul JSON summary',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/attachment_status\.mjs/,
  'the bounded refresh module is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/application_routes\.mjs/,
  'the mounted production application route graph is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/clearfolio\.mjs/,
  'the abortable Clearfolio adapter is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/orchestrator\.mjs/,
  'the contextual-orchestrator production boundary is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/billing_checkout_attempt\.mjs/,
  'the durable Checkout-attempt repository is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/stripe_webhook\.mjs/,
  'the Stripe webhook trust boundary is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/stripe_webhook_event_ledger\.mjs/,
  'the verified Stripe webhook event ledger is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/stripe_subscription_provider\.mjs/,
  'the authoritative Stripe subscription reader is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/stripe_subscription_observation_ledger\.mjs/,
  'the authoritative Stripe subscription observation ledger is instrumented',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
  'the Clearfolio signal and HTTP failure regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/orchestrator\.test\.mjs/,
  'the contextual-orchestrator behavior regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/orchestrator-coverage\.test\.mjs/,
  'the contextual-orchestrator edge coverage regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/orchestrator-attribution\.test\.mjs/,
  'the contextual-orchestrator attribution regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/billing-checkout-attempt\.test\.mjs/,
  'the durable Checkout-attempt regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/billing-checkout-reconciliation\.test\.mjs/,
  'the Checkout reconciliation operator regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/billing-provider-boundary\.test\.mjs/,
  'the Stripe provider trust and transport regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/stripe-webhook-boundary\.test\.mjs/,
  'the Stripe webhook trust regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/stripe-webhook-event-ledger\.test\.mjs/,
  'the durable Stripe webhook event-ledger regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/stripe-webhook-recorder-integration\.test\.mjs/,
  'the verified-event recorder integration regression executes under c8',
);
assert.match(
  scripts['test:unit'],
  /tests\/unit\/stripe-webhook-recorder-integration\.test\.mjs/,
  'normal unit CI executes the verified-event recorder integration regression',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/stripe-subscription-provider\.test\.mjs/,
  'the authoritative Stripe subscription reader regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/stripe-subscription-metadata-propagation\.test\.mjs/,
  'the subscription tenant-metadata propagation regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/stripe-subscription-observation-ledger\.test\.mjs/,
  'the authoritative Stripe subscription observation regression executes under c8',
);
assert.match(
  scripts['test:unit'],
  /tests\/unit\/stripe-subscription-observation-ledger\.test\.mjs/,
  'normal unit CI executes the authoritative Stripe subscription observation regression',
);
assert.doesNotMatch(
  scripts['test:coverage:cases'],
  /npm run (?:coverage|test:coverage)(?:\s|$)/,
  'coverage cases never recursively invoke a coverage wrapper',
);

console.log('✓ coverage script contract tests passed');
