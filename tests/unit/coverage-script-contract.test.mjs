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
  scripts['test:coverage:cases'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
  'the Clearfolio signal and HTTP failure regression executes under c8',
);
assert.doesNotMatch(
  scripts['test:coverage:cases'],
  /npm run (?:coverage|test:coverage)(?:\s|$)/,
  'coverage cases never recursively invoke a coverage wrapper',
);

const codeqlWorkflow = readFileSync(
  new URL('../../.github/workflows/codeql.yml', import.meta.url),
  'utf8',
);
const codeqlActions = [
  ...codeqlWorkflow.matchAll(
    /uses:\s*github\/codeql-action\/(init|analyze)@([0-9a-f]{40})\s*#\s*v(\d+\.\d+\.\d+)/g,
  ),
].map(([, action, digest, version]) => ({ action, digest, version }));
assert.deepEqual(
  codeqlActions.map(({ action }) => action).sort(),
  ['analyze', 'init'],
  'CodeQL workflow must pin exactly the init and analyze actions covered by this contract',
);
assert.equal(
  new Set(codeqlActions.map(({ version }) => version)).size,
  1,
  'CodeQL init and analyze must use the same released action version',
);
assert.equal(
  new Set(codeqlActions.map(({ digest }) => digest)).size,
  1,
  'CodeQL init and analyze must use the same immutable action commit',
);

console.log('✓ coverage script contract tests passed');
