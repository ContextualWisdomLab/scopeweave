import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../../.github/workflows/codeql.yml', import.meta.url),
  'utf8',
);
const requiredWorkflow = readFileSync(
  new URL('../../.github/workflows/codeql-required.yml', import.meta.url),
  'utf8',
);

const exactHeadRef = 'ref: ${{ github.event.pull_request.head.sha || github.sha }}';
const expectedShaEnv = 'EXPECTED_CHECKOUT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}';
const currentCodeqlSha = 'ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd';
const supersededCodeqlSha = '8aad20d150bbac5944a9f9d289da16a4b0d87c1e';
const protectedAnalyzeName = 'name: Analyze (${{ matrix.language }})';
const publisherAnalyzeName = 'name: Publish CodeQL (${{ matrix.language }})';

assert.equal(
  workflow.split(exactHeadRef).length - 1,
  1,
  'default CodeQL PR analysis must explicitly checkout the contributor head instead of the synthetic merge commit',
);
assert.equal(
  workflow.split(expectedShaEnv).length - 1,
  1,
  'default CodeQL must bind runtime attestation to the same expected exact-head SHA',
);
assert.equal(
  workflow.split('git rev-parse HEAD').length - 1,
  1,
  'default CodeQL must attest the commit it actually analyzes',
);
assert.equal(
  workflow.split('test "$actual_sha" = "$EXPECTED_CHECKOUT_SHA"').length - 1,
  1,
  'default CodeQL runtime attestation must fail closed when checkout does not match the expected exact head',
);
assert.equal(
  workflow.split('persist-credentials: false').length - 1,
  1,
  'default CodeQL checkout must retain least-privilege credential handling',
);
assert.equal(
  workflow.split(`github/codeql-action/init@${currentCodeqlSha} # v4.37.7`).length - 1,
  1,
  'default CodeQL initialization must use the reviewed immutable v4.37.7 action revision',
);
assert.equal(
  workflow.split(`github/codeql-action/analyze@${currentCodeqlSha} # v4.37.7`).length - 1,
  1,
  'default CodeQL analysis must use the reviewed immutable v4.37.7 action revision',
);
assert.equal(
  workflow.includes(supersededCodeqlSha),
  false,
  'default CodeQL must not regress to the superseded v4.36.2 action revision',
);
assert.doesNotMatch(
  workflow,
  /\bpull_request_target\s*:/,
  'default CodeQL must remain on the unprivileged pull_request trust boundary',
);
assert.equal(
  requiredWorkflow.split(protectedAnalyzeName).length - 1,
  1,
  'required CodeQL must remain the sole workflow provider of the protected Analyze check names',
);
assert.equal(
  workflow.includes(protectedAnalyzeName),
  false,
  'SARIF-publishing CodeQL must not duplicate the protected Analyze check names',
);
assert.equal(
  workflow.split(publisherAnalyzeName).length - 1,
  1,
  'SARIF-publishing CodeQL must expose a distinct review-visible check name',
);
assert.match(
  requiredWorkflow,
  /\bupload:\s*never\b/,
  'required CodeQL must not publish SARIF from the deterministic required-context lane',
);
assert.match(
  requiredWorkflow,
  /\bupload-database:\s*false\b/,
  'required CodeQL must not publish CodeQL databases from default-branch required-context runs',
);

console.log('✓ CodeQL exact-head and action supply-chain contract passed');
