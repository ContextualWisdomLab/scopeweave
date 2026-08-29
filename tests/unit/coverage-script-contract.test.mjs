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
  /test:coverage:node.*run-browser-coverage.*merge-browser-coverage/,
  'test:coverage runs Node and browser coverage before merging reports',
);
assert.match(
  scripts['test:coverage:node'],
  /\bc8\b.*--reporter=json(?![-\w]).*npm run test:coverage:cases/,
  'the Node coverage producer creates Istanbul JSON before executing cases',
);
assert.match(
  scripts['test:coverage:node'],
  /--reporter=json-summary\b/,
  'the Node coverage producer also creates the Istanbul JSON summary',
);
assert.match(
  scripts['test:coverage:node'],
  /--include=['"]?server\/\*\.mjs/,
  'all server modules are instrumented',
);
assert.equal(
  scripts['test:coverage:strict'],
  'npm run test:coverage && node scripts/ci/check-coverage.mjs',
  'the strict command checks the merged coverage summary',
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
