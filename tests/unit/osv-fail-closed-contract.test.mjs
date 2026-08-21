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

console.log('✓ OSV introduced-vulnerability gate fails closed');
