import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const osvWorkflow = readFileSync(
  new URL('../../.github/workflows/osvscanner.yml', import.meta.url),
  'utf8',
);

const codeqlUploadV4378 =
  'github/codeql-action/upload-sarif@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28 # v4.37.8';

assert.match(
  osvWorkflow,
  /^\s{2}scan:\s*$/m,
  'OSV must publish from the scan analysis identity that exists on protected develop, otherwise GHAS returns neutral configuration-not-found evidence',
);
assert.equal(
  osvWorkflow.split(codeqlUploadV4378).length - 1,
  1,
  'OSV must publish its differential SARIF with the reviewed immutable CodeQL upload action revision',
);
assert.equal(
  osvWorkflow.split('security-events: write').length - 1,
  1,
  'only the OSV analysis job must receive the permission required to restore its protected code-scanning configuration',
);
assert.match(
  osvWorkflow,
  /- name: Publish exact-head OSV SARIF to code scanning\r?\n\s+if: \$\{\{ !cancelled\(\) \}\}\r?\n\s+uses: github\/codeql-action\/upload-sarif@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28 # v4\.37\.8\r?\n\s+with:\r?\n\s+sarif_file: results\.sarif\r?\n\s+checkout_path: osv-scan-source\r?\n\s+ref: refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/head\r?\n\s+sha: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  'OSV SARIF publication must still run after a finding and bind GitHub code scanning to the exact submitted pull-request head rather than the synthetic merge SHA',
);
assert.match(
  osvWorkflow,
  /- name: Preserve exact-head OSV SARIF\r?\n\s+if: \$\{\{ !cancelled\(\) \}\}/,
  'OSV must preserve bounded workflow evidence as well as the code-scanning publication',
);
assert.doesNotMatch(
  osvWorkflow,
  /\bpull_request_target\s*:/,
  'restoring the OSV analysis configuration must not change the workflow to the privileged pull_request_target trust boundary',
);

console.log('✓ OSV protected analysis identity and exact-head SARIF publication contract passed');
