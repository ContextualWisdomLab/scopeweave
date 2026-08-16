import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const serverTestsWorkflow = readFileSync(
  new URL('../../.github/workflows/server-tests.yml', import.meta.url),
  'utf8',
);
const codeqlWorkflow = readFileSync(
  new URL('../../.github/workflows/codeql-required.yml', import.meta.url),
  'utf8',
);

const exactHeadRef = 'ref: ${{ github.event.pull_request.head.sha || github.sha }}';
const expectedShaEnv = 'EXPECTED_CHECKOUT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}';

assert.equal(
  serverTestsWorkflow.split(exactHeadRef).length - 1,
  2,
  'each Server Tests checkout must select the contributor head on PRs and github.sha on develop pushes',
);
assert.equal(
  serverTestsWorkflow.split(expectedShaEnv).length - 1,
  2,
  'each Server Tests job must bind its runtime verification to the same expected SHA',
);
assert.equal(
  serverTestsWorkflow.split('git rev-parse HEAD').length - 1,
  2,
  'each Server Tests job must inspect the commit it actually checked out',
);
assert.equal(
  serverTestsWorkflow.split('persist-credentials: false').length - 1,
  2,
  'exact-head checkout must not regress credential persistence hardening',
);
assert.doesNotMatch(
  serverTestsWorkflow,
  /\bpull_request_target\s*:/,
  'exact-head testing must not gain the privileged pull_request_target trust context',
);

assert.match(
  codeqlWorkflow,
  /name:\s*Analyze \(\$\{\{ matrix\.language \}\}\)/,
  'CodeQL must continue publishing the two protected-branch Analyze (...) required contexts',
);
assert.match(
  codeqlWorkflow,
  /- javascript-typescript\s*[\r\n]+\s*- python/,
  'CodeQL must analyze both JavaScript/TypeScript and Python',
);
assert.equal(
  codeqlWorkflow.split(exactHeadRef).length - 1,
  1,
  'CodeQL checkout must select the exact contributor head on pull requests',
);
assert.equal(
  codeqlWorkflow.split('persist-credentials: false').length - 1,
  1,
  'CodeQL exact-head checkout must not persist repository credentials',
);
assert.match(
  codeqlWorkflow,
  /\bupload:\s*never\b/,
  'required-context CodeQL must analyze locally without conflicting with repository default setup SARIF ownership',
);
assert.doesNotMatch(
  codeqlWorkflow,
  /\bpull_request_target\s*:/,
  'CodeQL must remain on the unprivileged pull_request trust boundary',
);

console.log('✓ Server Tests and required CodeQL exact-head workflow contracts passed');
