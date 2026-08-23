// This contract prevents a subtle CI regression: the central review gate may
// invoke `test:coverage` directly, so that script itself must create Istanbul
// JSON rather than merely execute tests without instrumentation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const publicApp = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');
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
  /--include=server\/clearfolio\.mjs/,
  'the abortable Clearfolio adapter is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/application_routes\.mjs/,
  'the protected application route graph remains owned-production coverage',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/stripe_webhook\.mjs/,
  'the Stripe webhook verifier is owned-production coverage',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/stripe-webhook-boundary\.test\.mjs/,
  'the raw-body Stripe trust-boundary regression executes under c8',
);
assert.match(
  scripts['test:api'],
  /tests\/api\/stripe-webhook\.test\.mjs/,
  'the public Stripe webhook entitlement regression executes in normal API CI',
);
assert.match(
  publicApp,
  /applicationRoutes\.routes\.filter\([\s\S]*method === ['"]POST['"][\s\S]*path === ['"]\/api\/stripe\/webhook['"][\s\S]*app\.on\(route\.method, route\.path, route\.handler\)/,
  'the public app preserves the protected route graph while excluding the historical unsigned Stripe handler',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
  'the Clearfolio signal and HTTP failure regression executes under c8',
);
assert.doesNotMatch(
  scripts['test:coverage:cases'],
  /npm run (?:coverage|test:coverage)(?:\s|$)/,
  'coverage cases never recursively invoke a coverage wrapper',
);

console.log('✓ coverage script contract tests passed');
