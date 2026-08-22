// This contract prevents subtle CI regressions in the coverage and fuzz gates.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  /--include=server\/runtime-app\.mjs/,
  'the deployed runtime routing module is instrumented',
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

const fuzzWorkflow = readFileSync(
  new URL('../../.github/workflows/fuzz.yml', import.meta.url),
  'utf8',
);
assert.match(
  fuzzWorkflow,
  /scripts\/ci\/select_fuzz_budget\.sh/,
  'the fuzz workflow delegates untrusted dispatch input to the bounded selector',
);
assert.doesNotMatch(
  fuzzWorkflow,
  /echo\s+["']?runs=\$INPUT_FUZZ_RUNS/,
  'the fuzz workflow never writes raw dispatch input to GITHUB_OUTPUT',
);

const fuzzBudgetScript = fileURLToPath(
  new URL('../../scripts/ci/select_fuzz_budget.sh', import.meta.url),
);
const budgetCases = [
  ['schedule', 'not-a-number', '200000'],
  ['workflow_dispatch', '1', '1'],
  ['workflow_dispatch', '20000', '20000'],
  ['workflow_dispatch', '200000', '200000'],
  ['workflow_dispatch', '', '20000'],
  ['workflow_dispatch', '0', '20000'],
  ['workflow_dispatch', '-1', '20000'],
  ['workflow_dispatch', 'abc', '20000'],
  ['workflow_dispatch', '200001', '20000'],
  ['workflow_dispatch', '1\n2', '20000'],
  ['workflow_dispatch', ' 10 ', '20000'],
];
for (const [eventName, requestedRuns, expectedRuns] of budgetCases) {
  const result = spawnSync(
    'bash',
    [fuzzBudgetScript, eventName, requestedRuns],
    { encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `${eventName}/${JSON.stringify(requestedRuns)} exits successfully`,
  );
  assert.equal(
    result.stderr,
    '',
    `${eventName}/${JSON.stringify(requestedRuns)} produces no stderr`,
  );
  assert.equal(
    result.stdout,
    `${expectedRuns}\n`,
    `${eventName}/${JSON.stringify(requestedRuns)} selects a bounded run count`,
  );
}

console.log('✓ coverage and fuzz CI contract tests passed');
