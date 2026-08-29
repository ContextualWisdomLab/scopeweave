// These contracts prevent CI from producing a false-green coverage signal:
// the canonical script must emit Istanbul evidence and the required Server Tests
// workflow must actually execute that script on every pull request.
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
  scripts['test:coverage'],
  /--include=json-sync-bootstrap-guard\.js/,
  'the JSON sync bootstrap guard is instrumented',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
  'the Clearfolio signal and HTTP failure regression executes under c8',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/json-sync-bootstrap-guard\.test\.mjs/,
  'the JSON sync bootstrap guard behavior executes under c8',
);
assert.doesNotMatch(
  scripts['test:coverage:cases'],
  /npm run (?:coverage|test:coverage)(?:\s|$)/,
  'coverage cases never recursively invoke a coverage wrapper',
);
assert.match(
  serverTestsWorkflow,
  /name:\s+Owned production coverage[\s\S]*?run:\s+npm run test:coverage\b/,
  'the required Server Tests workflow executes owned production coverage',
);

console.log('✓ coverage script contract tests passed');
