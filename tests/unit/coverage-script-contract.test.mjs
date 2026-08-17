// This contract prevents a subtle CI regression: the central review gate may
// invoke `test:coverage` directly, so that script itself must create Istanbul
// JSON rather than merely execute tests without instrumentation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const scripts = packageJson.scripts;
const fuzzWorkflow = readFileSync(
  new URL('../../.github/workflows/fuzz.yml', import.meta.url),
  'utf8',
);
const osvWorkflow = readFileSync(
  new URL('../../.github/workflows/osvscanner.yml', import.meta.url),
  'utf8',
);
const codeqlWorkflow = readFileSync(
  new URL('../../.github/workflows/codeql.yml', import.meta.url),
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
  fuzzWorkflow,
  /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\s+# v7\.0\.0/,
  'property fuzz uses the immutable setup-node v7 runtime that declares node24',
);
assert.doesNotMatch(
  fuzzWorkflow,
  /actions\/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af/,
  'property fuzz no longer relies on the deprecated Node.js 20 setup-node runtime',
);
assert.ok(
  fuzzWorkflow.includes('ref: ${{ github.event.pull_request.head.sha || github.sha }}'),
  'property fuzz checks out the exact contributor head rather than the synthetic pull-request merge',
);
assert.ok(
  fuzzWorkflow.includes('EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}'),
  'property fuzz records the exact expected contributor SHA for checkout attestation',
);
assert.match(
  fuzzWorkflow,
  /git rev-parse HEAD[\s\S]*\$EXPECTED_SHA/,
  'property fuzz fails closed unless the checked-out commit matches the exact expected contributor SHA',
);

assert.doesNotMatch(
  osvWorkflow,
  /osv-scanner-reusable-pr\.yml/,
  'OSV evidence must not delegate PR checkout authority to a reusable workflow that scans GITHUB_SHA',
);
assert.ok(
  osvWorkflow.includes('HEAD_SHA: ${{ github.event.pull_request.head.sha }}'),
  'OSV scanning binds the new-code scan to the exact contributor head',
);
assert.ok(
  osvWorkflow.includes('BASE_REF: ${{ github.event.pull_request.base.ref }}'),
  'OSV scanning records the protected base ref so it can resolve the live tip independently',
);
assert.match(
  osvWorkflow,
  /git fetch --no-tags origin[\s\S]*refs\/heads\/\$\{BASE_REF\}:refs\/remotes\/origin\/\$\{BASE_REF\}/,
  'OSV scanning resolves the live protected base tip rather than trusting the PR base snapshot',
);
assert.match(
  osvWorkflow,
  /git checkout --detach "\$HEAD_SHA"[\s\S]*git rev-parse HEAD[\s\S]*\$HEAD_SHA/,
  'OSV scanning checks out and attests the exact contributor head before the new-code scan',
);

assert.ok(
  codeqlWorkflow.includes('ref: ${{ github.event.pull_request.head.sha || github.sha }}'),
  'CodeQL checks out the exact contributor head on pull requests rather than the synthetic merge',
);
assert.ok(
  codeqlWorkflow.includes('EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}'),
  'CodeQL records the exact expected source SHA before initialization',
);
assert.match(
  codeqlWorkflow,
  /git rev-parse HEAD[\s\S]*\$EXPECTED_SHA[\s\S]*Initialize CodeQL/,
  'CodeQL attests the exact checkout before initializing the database',
);

console.log('✓ coverage script contract tests passed');