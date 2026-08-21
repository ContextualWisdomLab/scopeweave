import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
    osvWorkflow.split(`test -s ${resultFile}`).length - 1,
    1,
    `${stepId} failure may proceed to reporting only when it produced ${resultFile}`,
  );
}

console.log('✓ OSV introduced-vulnerability, checkout-isolation, and scan-completion gates fail closed');
