// This contract prevents subtle CI regressions in required evidence. Coverage
// commands must keep producing canonical Istanbul artifacts, and the protected
// browser gate must execute the complete Playwright suite rather than a static
// subset that can silently omit new regression specs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const scripts = packageJson.scripts;
const serverTestsWorkflow = readFileSync(
  new URL('../../.github/workflows/server-tests.yml', import.meta.url),
  'utf8',
);

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
  scripts['test:coverage:cases'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
  'the Clearfolio signal and HTTP failure regression executes under c8',
);
assert.doesNotMatch(
  scripts['test:coverage:cases'],
  /npm run (?:coverage|test:coverage)(?:\s|$)/,
  'coverage cases never recursively invoke a coverage wrapper',
);
assert.match(
  serverTestsWorkflow,
  /name:\s*Cloud UI e2e\s*\n\s*run:\s*npm run test:e2e(?:\s|$)/,
  'the required cloud-e2e job executes the complete Playwright suite so new regressions cannot be silently omitted',
);
assert.doesNotMatch(
  serverTestsWorkflow,
  /name:\s*Cloud UI e2e\s*\n\s*run:\s*npm run test:e2e:cloud(?:\s|$)/,
  'the required cloud-e2e job must not use the historical static two-spec subset',
);

console.log('✓ coverage and required browser-gate contract tests passed');
