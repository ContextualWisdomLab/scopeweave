import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fuzzWorkflow = readFileSync(
  new URL('../../.github/workflows/fuzz.yml', import.meta.url),
  'utf8',
);

const exactHeadRef = 'ref: ${{ github.event.pull_request.head.sha || github.sha }}';
const expectedShaEnv = 'EXPECTED_CHECKOUT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}';
const immutableCheckout =
  'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0';
const setupNodeV7 =
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0';
const deprecatedSetupNodeV4 =
  'actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af';

assert.equal(
  fuzzWorkflow.split(immutableCheckout).length - 1,
  1,
  'the protected property-fuzz context must use the reviewed immutable checkout action',
);
assert.equal(
  fuzzWorkflow.split(exactHeadRef).length - 1,
  1,
  'property fuzz must select the contributor head on pull requests and github.sha on develop pushes',
);
assert.equal(
  fuzzWorkflow.split(expectedShaEnv).length - 1,
  1,
  'property fuzz must bind runtime checkout verification to the same expected revision',
);
assert.equal(
  fuzzWorkflow.split('git rev-parse HEAD').length - 1,
  1,
  'property fuzz must inspect the revision that the runner actually checked out',
);
assert.equal(
  fuzzWorkflow.split('test "$actual_sha" = "$EXPECTED_CHECKOUT_SHA"').length - 1,
  1,
  'property fuzz must fail closed when GitHub checks out a synthetic or otherwise unexpected revision',
);
assert.equal(
  fuzzWorkflow.split('persist-credentials: false').length - 1,
  1,
  'property fuzz must not persist repository credentials after exact-head checkout',
);
assert.equal(
  fuzzWorkflow.split(setupNodeV7).length - 1,
  1,
  'property fuzz must use the reviewed immutable setup-node v7 action runtime',
);
assert.equal(
  fuzzWorkflow.includes(deprecatedSetupNodeV4),
  false,
  'property fuzz must not regress to the deprecated setup-node v4 action runtime',
);
assert.doesNotMatch(
  fuzzWorkflow,
  /\bpull_request_target\s*:/,
  'exact-head fuzzing must remain on the unprivileged pull_request trust boundary',
);
assert.match(
  fuzzWorkflow,
  /scripts\/ci\/select_fuzz_budget\.sh/,
  'property fuzz must delegate workflow_dispatch input to the bounded selector',
);
assert.doesNotMatch(
  fuzzWorkflow,
  /echo\s+["']?runs=\$\{\{ github\.event\.inputs\.fuzz_runs \}\}/,
  'property fuzz must never write raw workflow_dispatch input to GITHUB_OUTPUT',
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

console.log('✓ protected property fuzz exact-head, action-runtime, and dispatch-budget contracts passed');
