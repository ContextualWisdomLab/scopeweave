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
  /--include=server\/clearfolio\.mjs/,
  'the abortable Clearfolio adapter is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/access_grant_domain\.mjs/,
  'the short-lived access-grant domain is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/calendar_subscription_domain\.mjs/,
  'the durable calendar-subscription domain is instrumented',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/access-grant-domain\.test\.mjs/,
  'the access-grant behavior contract executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/access-grant-domain-edge\.test\.mjs/,
  'the access-grant edge cases execute under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/calendar-subscription-domain\.test\.mjs/,
  'the calendar-subscription lifecycle contract executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/calendar-subscription-domain-edge\.test\.mjs/,
  'the calendar-subscription failure boundaries execute under c8',
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
