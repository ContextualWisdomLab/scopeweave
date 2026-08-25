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
  /--include=server\/work_item_hierarchy\.mjs/,
  'the work-item hierarchy domain is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/schedule_outcome_domain\.mjs/,
  'the schedule-outcome domain is instrumented',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/schedule_reason_event_domain\.mjs/,
  'the schedule reason-event authorization domain is instrumented',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
  'the Clearfolio signal and HTTP failure regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/work-item-hierarchy\.test\.mjs/,
  'the work-item hierarchy behavior contract executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/schedule-outcome-domain\.test\.mjs/,
  'the schedule-outcome behavior contract executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/schedule-outcome-domain-edge\.test\.mjs/,
  'the schedule-outcome failure-boundary contract executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/schedule-reason-event-domain\.test\.mjs/,
  'the schedule reason-event authority and audit contract executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/schedule-reason-self-approval\.test\.mjs/,
  'the independent cancellation-approval regression executes under c8',
);
assert.doesNotMatch(
  scripts['test:coverage:cases'],
  /npm run (?:coverage|test:coverage)(?:\s|$)/,
  'coverage cases never recursively invoke a coverage wrapper',
);

console.log('✓ coverage script contract tests passed');
