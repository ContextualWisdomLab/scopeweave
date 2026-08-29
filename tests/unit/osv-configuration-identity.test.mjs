import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const osvWorkflow = readFileSync(
  new URL('../../.github/workflows/osvscanner.yml', import.meta.url),
  'utf8',
);

assert.match(
  osvWorkflow,
  /^\s{2}osv-scan:\s*$/m,
  'OSV must preserve the protected-base osv-scan job identity so GitHub can compare the same analysis configuration across base and contributor heads',
);
assert.doesNotMatch(
  osvWorkflow,
  /^\s{2}scan:\s*$/m,
  'OSV must not rename the protected-base analysis job because GitHub treats that as a missing code-scanning configuration and returns neutral evidence',
);

console.log('✓ OSV analysis configuration identity remains stable across protected base and contributor heads');
