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
const osvWorkflow = readFileSync(
  new URL('../../.github/workflows/osvscanner.yml', import.meta.url),
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
  codeqlWorkflow.split(expectedShaEnv).length - 1,
  1,
  'CodeQL verification must bind to the exact expected SHA',
);
assert.equal(
  codeqlWorkflow.split('git rev-parse HEAD').length - 1,
  1,
  'CodeQL must inspect the commit it actually checked out',
);
assert.equal(
  codeqlWorkflow.split('test "$actual_sha" = "$EXPECTED_CHECKOUT_SHA"').length - 1,
  1,
  'CodeQL must fail when the actual checkout differs from the expected SHA',
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

const liveBaseRef = 'ref: ${{ github.event.pull_request.base.ref }}';
const liveBaseRefEnv = 'BASE_REF: ${{ github.event.pull_request.base.ref }}';
const osvExactHeadRef = 'ref: ${{ github.event.pull_request.head.sha }}';
const expectedHeadShaEnv = 'EXPECTED_HEAD_SHA: ${{ github.event.pull_request.head.sha }}';
const osvScannerV250Pin =
  'google/osv-scanner-action/osv-scanner-action@06b2ab4348248b456ee06c9e953637f55e03504f # v2.5.0';
const osvReporterV250Pin =
  'google/osv-scanner-action/osv-reporter-action@06b2ab4348248b456ee06c9e953637f55e03504f # v2.5.0';

assert.match(
  osvWorkflow,
  /^\s{2}scan:\s*$/m,
  'OSV must retain the stable scan job identity used by protected-base code-scanning comparisons',
);
assert.equal(
  osvWorkflow.split(liveBaseRef).length - 1,
  1,
  'OSV baseline checkout must resolve the live protected base ref instead of trusting the PR base snapshot SHA',
);
assert.equal(
  osvWorkflow.split(liveBaseRefEnv).length - 1,
  1,
  'OSV baseline evidence must identify the protected base ref whose live tip was resolved by checkout',
);
assert.doesNotMatch(
  osvWorkflow,
  /github\.event\.pull_request\.base\.sha/,
  'OSV must not treat the historical pull-request base SHA snapshot as the current protected base tip',
);
assert.equal(
  osvWorkflow.split(osvExactHeadRef).length - 1,
  1,
  'OSV must explicitly check out the exact contributor head for the candidate scan',
);
assert.match(
  osvWorkflow,
  /- name: Checkout exact contributor revision[\s\S]*?with:\s*[\r\n]+\s*ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}[\r\n]+\s*persist-credentials: false[\r\n]+\s*clean: false/,
  'OSV contributor checkout must preserve the live-base old-results.json across the second checkout',
);
assert.equal(
  osvWorkflow.split('persist-credentials: false').length - 1,
  2,
  'both OSV checkouts must avoid persisting repository credentials',
);
assert.equal(
  osvWorkflow.split('git rev-parse HEAD').length - 1,
  2,
  'OSV must record the live-base revision it resolved and verify the contributor commit it actually scans',
);
assert.equal(
  osvWorkflow.split(expectedHeadShaEnv).length - 1,
  1,
  'OSV candidate verification must bind to the pull-request contributor SHA',
);
assert.doesNotMatch(
  osvWorkflow,
  /osv-scanner-reusable-pr\.yml/,
  'OSV must not delegate candidate selection to the reusable workflow that scans synthetic GITHUB_SHA merge commits',
);
assert.equal(
  osvWorkflow.split(osvScannerV250Pin).length - 1,
  2,
  'OSV must scan both immutable revisions with the direct action pinned by upstream v2.5.0',
);
assert.equal(
  osvWorkflow.split(osvReporterV250Pin).length - 1,
  1,
  'OSV must compare introduced vulnerabilities with the reporter pinned by upstream v2.5.0',
);
assert.doesNotMatch(
  osvWorkflow,
  /8dc09193bb540e09b23da07ad7e30bd33bf87018|# v2\.3\.8/,
  'OSV must not regress to the superseded v2.3.8 action revision or annotation',
);
assert.match(
  osvWorkflow,
  /github\/codeql-action\/upload-sarif@8aad20d150bbac5944a9f9d289da16a4b0d87c1e/,
  'OSV must publish candidate-head SARIF through the repository-trusted pinned upload action',
);
assert.doesNotMatch(
  osvWorkflow,
  /\bpull_request_target\s*:/,
  'OSV must remain on the unprivileged pull_request trust boundary',
);

console.log('✓ Server Tests, required CodeQL, and OSV exact-head/live-base workflow contracts passed');
