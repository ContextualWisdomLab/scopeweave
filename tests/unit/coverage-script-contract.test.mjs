// This contract prevents a subtle CI regression: the central review gate may
// invoke `test:coverage` directly, so that script itself must create Istanbul
// JSON, enforce complete owned-production coverage, and execute the complete
// deterministic unit/API suite rather than a hand-maintained test subset.
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
for (const requiredCoverageOption of [
  '--check-coverage',
  '--lines 100',
  '--functions 100',
  '--branches 100',
  '--statements 100',
]) {
  assert.equal(
    scripts['test:coverage'].includes(requiredCoverageOption),
    true,
    `test:coverage must enforce ${requiredCoverageOption}`,
  );
}
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
assert.equal(
  scripts['test:coverage:cases'],
  'npm run test:unit && npm run test:api',
  'coverage must instrument the complete deterministic unit and API suites instead of a stale curated subset',
);
assert.match(
  scripts['test:unit'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
  'the complete unit suite retains the Clearfolio signal and HTTP failure regression',
);
assert.doesNotMatch(
  scripts['test:coverage:cases'],
  /npm run (?:coverage|test:coverage)(?:\s|$)/,
  'coverage cases never recursively invoke a coverage wrapper',
);

console.log('✓ coverage script contract tests passed');
