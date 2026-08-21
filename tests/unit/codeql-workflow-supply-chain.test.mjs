import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const advancedWorkflowUrl = new URL('../../.github/workflows/codeql.yml', import.meta.url);
const requiredWorkflow = readFileSync(
  new URL('../../.github/workflows/codeql-required.yml', import.meta.url),
  'utf8',
);

const exactHeadRef = 'ref: ${{ github.event.pull_request.head.sha || github.sha }}';
const expectedShaEnv = 'EXPECTED_CHECKOUT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}';
const currentCodeqlSha = 'ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd';
const supersededCodeqlSha = '8aad20d150bbac5944a9f9d289da16a4b0d87c1e';
const protectedAnalyzeName = 'name: Analyze (${{ matrix.language }})';

assert.equal(
  existsSync(advancedWorkflowUrl),
  false,
  'default-setup SARIF authority must not coexist with a repository advanced CodeQL publisher workflow',
);
assert.equal(
  requiredWorkflow.split(exactHeadRef).length - 1,
  1,
  'required CodeQL PR analysis must explicitly checkout the contributor head instead of the synthetic merge commit',
);
assert.equal(
  requiredWorkflow.split(expectedShaEnv).length - 1,
  1,
  'required CodeQL must bind runtime attestation to the same expected exact-head SHA',
);
assert.equal(
  requiredWorkflow.split('git rev-parse HEAD').length - 1,
  1,
  'required CodeQL must attest the commit it actually analyzes',
);
assert.equal(
  requiredWorkflow.split('test "$actual_sha" = "$EXPECTED_CHECKOUT_SHA"').length - 1,
  1,
  'required CodeQL runtime attestation must fail closed when checkout does not match the expected exact head',
);
assert.equal(
  requiredWorkflow.split('persist-credentials: false').length - 1,
  1,
  'required CodeQL checkout must retain least-privilege credential handling',
);
assert.equal(
  requiredWorkflow.split(`github/codeql-action/init@${currentCodeqlSha} # v4.37.7`).length - 1,
  1,
  'required CodeQL initialization must use the reviewed immutable v4.37.7 action revision',
);
assert.equal(
  requiredWorkflow.split(`github/codeql-action/analyze@${currentCodeqlSha} # v4.37.7`).length - 1,
  1,
  'required CodeQL analysis must use the reviewed immutable v4.37.7 action revision',
);
assert.equal(
  requiredWorkflow.includes(supersededCodeqlSha),
  false,
  'required CodeQL must not regress to the superseded v4.36.2 action revision',
);
assert.doesNotMatch(
  requiredWorkflow,
  /\bpull_request_target\s*:/,
  'required CodeQL must remain on the unprivileged pull_request trust boundary',
);
assert.equal(
  requiredWorkflow.split(protectedAnalyzeName).length - 1,
  1,
  'required CodeQL must remain the sole repository workflow provider of the protected Analyze check names',
);
assert.match(
  requiredWorkflow,
  /\bupload:\s*never\b/,
  'required CodeQL must not publish SARIF while GitHub default setup owns publication',
);
assert.match(
  requiredWorkflow,
  /\bupload-database:\s*false\b/,
  'required CodeQL must not publish CodeQL databases from default-branch required-context runs',
);

console.log('✓ CodeQL exact-head, default-setup authority, and supply-chain contract passed');
