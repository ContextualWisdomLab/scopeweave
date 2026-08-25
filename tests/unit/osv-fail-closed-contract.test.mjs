import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const osvWorkflow = readFileSync(
  new URL('../../.github/workflows/osvscanner.yml', import.meta.url),
  'utf8',
);

assert.match(
  osvWorkflow,
  /google\/osv-scanner-action\/osv-reporter-action@/,
  'OSV dependency comparison must retain the upstream reporter action',
);
assert.match(
  osvWorkflow,
  /--fail-on-vuln=true\b/,
  'OSV must fail when the contributor head introduces a vulnerability',
);
assert.doesNotMatch(
  osvWorkflow,
  /--fail-on-vuln=false\b/,
  'OSV must not convert newly introduced vulnerabilities into a passing gate',
);

const osvEvidenceArtifactPin =
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1';
const codeqlUploadSarifV4378Pin =
  'github/codeql-action/upload-sarif@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28 # v4.37.8';
assert.equal(
  osvWorkflow.split(codeqlUploadSarifV4378Pin).length - 1,
  1,
  'OSV must publish exact-head SARIF through the reviewed immutable CodeQL upload action revision',
);
assert.equal(
  osvWorkflow.split('security-events: write').length - 1,
  1,
  'the OSV scan job must have exactly one code-scanning write grant for SARIF publication',
);
assert.match(
  osvWorkflow,
  /- name: Publish exact-head OSV SARIF to code scanning\r?\n\s+if: \$\{\{ !cancelled\(\) \}\}\r?\n\s+uses: github\/codeql-action\/upload-sarif@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28 # v4\.37\.8\r?\n\s+with:\r?\n\s+sarif_file: results\.sarif\r?\n\s+checkout_path: \$\{\{ github\.workspace \}\}\/osv-scan-source\r?\n\s+ref: refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/head\r?\n\s+sha: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  'OSV code-scanning evidence must bind the uploaded SARIF to the exact contributor checkout and pull-request head ref',
);
assert.doesNotMatch(
  osvWorkflow,
  /^\s+category:\s/m,
  'OSV must preserve the existing workflow/job analysis identity instead of creating an unmatched category',
);
assert.equal(
  osvWorkflow.split(osvEvidenceArtifactPin).length - 1,
  1,
  'OSV SARIF evidence must use the reviewed immutable upload-artifact revision',
);
assert.match(
  osvWorkflow,
  /- name: Preserve exact-head OSV SARIF\r?\n\s+if: \$\{\{ !cancelled\(\) \}\}\r?\n\s+uses: actions\/upload-artifact@[\s\S]*?name: scopeweave-osv-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}[\s\S]*?path: results\.sarif[\s\S]*?if-no-files-found: error[\s\S]*?retention-days: 3/,
  'OSV must retain exact-head SARIF as bounded workflow evidence even when introduced vulnerabilities fail the reporter',
);

const isolatedCheckoutPath = 'path: osv-scan-source';
assert.equal(
  osvWorkflow.split(isolatedCheckoutPath).length - 1,
  2,
  'both OSV source checkouts must be isolated below the workspace evidence files',
);
assert.equal(
  osvWorkflow.split('-r\n            ./osv-scan-source').length - 1,
  2,
  'base and contributor scans must inspect the same isolated source path',
);
assert.match(
  osvWorkflow,
  /- name: Sanitize exact contributor scan tree\r?\n\s+run: \|\r?\n\s+set -euo pipefail\r?\n\s+git -C osv-scan-source clean -ffdx\r?\n\s+test -z "\$\(git -C osv-scan-source status --porcelain\)"/,
  'OSV must remove base-only untracked artifacts before scanning the exact contributor tree',
);
for (const resultFile of ['old-results.json', 'new-results.json', 'results.sarif']) {
  assert.match(
    osvWorkflow,
    new RegExp(`--(?:output|old|new)=${resultFile.replace('.', '\\.')}`),
    `${resultFile} must remain a workspace-root evidence file outside the untrusted checkout`,
  );
  assert.doesNotMatch(
    osvWorkflow,
    new RegExp(`--(?:output|old|new)=\\.?/?osv-scan-source/${resultFile.replace('.', '\\.')}`),
    `${resultFile} must not be written inside the untrusted checkout`,
  );
}

assert.equal(
  osvWorkflow.split('continue-on-error: true').length - 1,
  2,
  'both OSV scans must continue only far enough to distinguish findings from scanner failure',
);
for (const [stepId, resultFile] of [
  ['scan-base', 'old-results.json'],
  ['scan-head', 'new-results.json'],
]) {
  assert.equal(
    osvWorkflow.split(`id: ${stepId}`).length - 1,
    1,
    `${stepId} must expose the scanner step outcome before continue-on-error rewrites its conclusion`,
  );
  assert.equal(
    osvWorkflow.split(`if: \${{ steps.${stepId}.outcome == 'failure' }}`).length - 1,
    1,
    `${stepId} must run a completion guard whenever the scanner reports failure`,
  );
  assert.equal(
    osvWorkflow.split(`RESULT_FILE: ${resultFile}`).length - 1,
    1,
    `${stepId} must bind its completion guard to ${resultFile}`,
  );
}

const completionGuardPattern = /node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/g;
const completionGuards = [...osvWorkflow.matchAll(completionGuardPattern)].map((match) => match[1]);
assert.equal(
  completionGuards.length,
  2,
  'base and contributor failure paths must each execute a structured OSV result validator',
);

function runCompletionGuard(guardSource, resultFile, payload) {
  const workdir = mkdtempSync(join(tmpdir(), 'scopeweave-osv-guard-'));
  try {
    writeFileSync(join(workdir, resultFile), payload, 'utf8');
    return spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', guardSource],
      {
        cwd: workdir,
        env: { ...process.env, RESULT_FILE: resultFile },
        encoding: 'utf8',
      },
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

const vulnerabilityEvidence = JSON.stringify({
  results: [{
    packages: [{
      package: { ecosystem: 'npm', name: 'example-package', version: '1.0.0' },
      vulnerabilities: [{ id: 'OSV-TEST-1' }],
    }],
  }],
});
const ambiguousFailureEvidence = [
  ['malformed JSON', '{'],
  ['missing results array', JSON.stringify({})],
  ['empty results array', JSON.stringify({ results: [] })],
  ['finding-free results', JSON.stringify({ results: [{ packages: [] }] })],
];

for (const [index, guardSource] of completionGuards.entries()) {
  const resultFile = index === 0 ? 'old-results.json' : 'new-results.json';
  const accepted = runCompletionGuard(guardSource, resultFile, vulnerabilityEvidence);
  assert.equal(
    accepted.status,
    0,
    `${resultFile} failure guard must allow structured vulnerability evidence to reach differential reporting: ${accepted.stderr}`,
  );

  for (const [label, payload] of ambiguousFailureEvidence) {
    const rejected = runCompletionGuard(guardSource, resultFile, payload);
    assert.notEqual(
      rejected.status,
      0,
      `${resultFile} failure guard must reject ${label} instead of treating a scanner failure as completed evidence`,
    );
  }
}

console.log('✓ OSV introduced-vulnerability, exact-head code-scanning, checkout-isolation, evidence-ownership, and structured scan-completion gates fail closed');
