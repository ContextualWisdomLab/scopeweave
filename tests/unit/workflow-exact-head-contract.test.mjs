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
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const serverCoverageScript = packageJson.scripts?.['test:coverage:server'] ?? '';
const browserCoverageScript = packageJson.scripts?.['test:coverage:browser'] ?? '';
const coverageCasesScript = packageJson.scripts?.['test:coverage:cases'] ?? '';

const exactHeadRef = 'ref: ${{ github.event.pull_request.head.sha || github.sha }}';
const expectedShaEnv = 'EXPECTED_CHECKOUT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}';
const codeqlActionV4378Sha = 'db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28';
const supersededCodeqlActionV4362Sha = '8aad20d150bbac5944a9f9d289da16a4b0d87c1e';

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
  serverTestsWorkflow,
  /- name: Install Playwright \(chromium for coverage\)\r?\n\s+timeout-minutes: 10\r?\n\s+run: npx playwright install chromium\r?\n[\s\S]*?- name: Exact owned production coverage/,
  'the unit-and-api coverage lane must install the real Chromium runtime with its bounded non-apt path before browser coverage executes',
);
assert.match(
  serverTestsWorkflow,
  /- name: Exact owned production coverage\r?\n\s+id: coverage\r?\n\s+run: npm run test:coverage\b/,
  'Server Tests must execute and identify the exact-head owned-production coverage gate',
);
assert.match(
  serverTestsWorkflow,
  /- name: Coverage failure diagnostics[\s\S]*?if: \$\{\{ failure\(\) && steps\.coverage\.conclusion == 'failure' \}\}[\s\S]*?node scripts\/ci\/coverage_diagnostics\.mjs "\$report"/,
  'coverage diagnostics must run only when the exact coverage step itself fails',
);
assert.match(
  serverTestsWorkflow,
  /for report in coverage\/coverage-final\.json coverage\/browser-coverage-final\.json/,
  'coverage failure diagnostics must inspect the actual server and browser Istanbul reports emitted by the coverage producers',
);
assert.match(
  serverTestsWorkflow,
  /if \[ -f "\$report" \]; then[\s\S]*?node scripts\/ci\/coverage_diagnostics\.mjs "\$report"/,
  'coverage diagnostics must tolerate a server-side failure before the browser report exists',
);
const coverageArtifactPin =
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1';
assert.equal(
  serverTestsWorkflow.split(coverageArtifactPin).length - 1,
  1,
  'coverage failure evidence must use the reviewed immutable upload-artifact revision',
);
assert.match(
  serverTestsWorkflow,
  /- name: Preserve exact coverage failure evidence[\s\S]*?if: \$\{\{ failure\(\) && steps\.coverage\.conclusion == 'failure' \}\}[\s\S]*?name: scopeweave-coverage-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}[\s\S]*?coverage\/coverage-final\.json[\s\S]*?coverage\/coverage-summary\.json[\s\S]*?coverage\/browser-coverage-final\.json[\s\S]*?coverage\/browser-coverage-summary\.json[\s\S]*?if-no-files-found: error[\s\S]*?retention-days: 3/,
  'failed coverage runs must retain exact server and browser Istanbul evidence only for coverage-step failures',
);
assert.match(
  serverTestsWorkflow,
  /- name: Public docstring gate[\s\S]*?run: npm run check:python-docstrings\b/,
  'Server Tests must execute the public docstring applicability gate',
);
for (const requiredCoverageOption of [
  '--all',
  '--check-coverage',
  '--per-file',
  '--lines 100',
  '--functions 100',
  '--branches 100',
  '--statements 100',
]) {
  assert.equal(
    serverCoverageScript.includes(requiredCoverageOption),
    true,
    `test:coverage:server must enforce ${requiredCoverageOption}`,
  );
}
assert.equal(
  coverageCasesScript,
  'npm run test:unit && npm run test:api',
  'the exact server coverage case set must continue executing both unit and API suites',
);
assert.doesNotMatch(
  serverTestsWorkflow,
  /^\s+run: npm run test:(?:unit|api)\s*$/m,
  'Server Tests must not execute unit or API suites outside the exact coverage gate when coverage already owns those cases',
);
assert.equal(
  browserCoverageScript,
  'node scripts/ci/browser_coverage.mjs',
  'test:coverage:browser must execute the repository-owned real-browser collector',
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
assert.equal(
  codeqlWorkflow.split(`github/codeql-action/init@${codeqlActionV4378Sha} # v4.37.8`).length - 1,
  1,
  'CodeQL initialization must use the reviewed immutable v4.37.8 action revision',
);
assert.equal(
  codeqlWorkflow.split(`github/codeql-action/analyze@${codeqlActionV4378Sha} # v4.37.8`).length - 1,
  1,
  'CodeQL analysis must use the reviewed immutable v4.37.8 action revision',
);
assert.equal(
  codeqlWorkflow.includes(supersededCodeqlActionV4362Sha),
  false,
  'CodeQL Required must not regress to the superseded v4.36.2 action revision',
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
const osvScannerV251Pin =
  'google/osv-scanner-action/osv-scanner-action@6e4298ebc4db23e847df9b2e2de2939d6f066c67 # v2.5.1';
const osvReporterV251Pin =
  'google/osv-scanner-action/osv-reporter-action@6e4298ebc4db23e847df9b2e2de2939d6f066c67 # v2.5.1';

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
  osvWorkflow.split(osvScannerV251Pin).length - 1,
  2,
  'OSV must scan both immutable revisions with the direct action pinned by upstream v2.5.1',
);
assert.equal(
  osvWorkflow.split(osvReporterV251Pin).length - 1,
  1,
  'OSV must compare introduced vulnerabilities with the reporter pinned by upstream v2.5.1',
);
assert.doesNotMatch(
  osvWorkflow,
  /8dc09193bb540e09b23da07ad7e30bd33bf87018|# v2\.3\.8/,
  'OSV must not regress to the superseded v2.3.8 action revision or annotation',
);
assert.equal(
  osvWorkflow.split(coverageArtifactPin).length - 1,
  1,
  'OSV exact-head SARIF evidence must use the reviewed immutable upload-artifact revision',
);
assert.match(
  osvWorkflow,
  /- name: Preserve exact-head OSV SARIF\r?\n\s+if: \$\{\{ !cancelled\(\) \}\}\r?\n\s+uses: actions\/upload-artifact@[\s\S]*?name: scopeweave-osv-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}[\s\S]*?path: results\.sarif[\s\S]*?if-no-files-found: error[\s\S]*?retention-days: 3/,
  'OSV must retain generated exact-head SARIF evidence even when the reporter fails on an introduced vulnerability, while still skipping cancelled runs',
);
assert.doesNotMatch(
  osvWorkflow,
  /github\/codeql-action\/upload-sarif@/,
  'OSV must not publish a second SARIF stream into the CodeQL-only code-scanning surface',
);
assert.doesNotMatch(
  osvWorkflow,
  /\bsecurity-events:\s*write\b/,
  'OSV evidence retention must not require code-scanning write authority',
);
assert.equal(
  osvWorkflow.includes(supersededCodeqlActionV4362Sha),
  false,
  'OSV evidence retention must not regress to a superseded CodeQL action revision',
);
assert.doesNotMatch(
  osvWorkflow,
  /\bpull_request_target\s*:/,
  'OSV must remain on the unprivileged pull_request trust boundary',
);

console.log('✓ Server Tests, required CodeQL, and OSV exact-head/live-base workflow contracts passed');
