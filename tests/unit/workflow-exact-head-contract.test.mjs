import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../../.github/workflows/server-tests.yml', import.meta.url),
  'utf8',
);

const exactHeadRef = 'ref: ${{ github.event.pull_request.head.sha || github.sha }}';
const expectedShaEnv = 'EXPECTED_CHECKOUT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}';

assert.equal(
  workflow.split(exactHeadRef).length - 1,
  2,
  'each Server Tests checkout must select the contributor head on PRs and github.sha on develop pushes',
);
assert.equal(
  workflow.split(expectedShaEnv).length - 1,
  2,
  'each Server Tests job must bind its runtime verification to the same expected SHA',
);
assert.equal(
  workflow.split('git rev-parse HEAD').length - 1,
  2,
  'each Server Tests job must inspect the commit it actually checked out',
);
assert.equal(
  workflow.split('persist-credentials: false').length - 1,
  2,
  'exact-head checkout must not regress credential persistence hardening',
);
assert.doesNotMatch(
  workflow,
  /\bpull_request_target\s*:/,
  'exact-head testing must not gain the privileged pull_request_target trust context',
);

console.log('✓ Server Tests exact-head workflow contract passed');
