import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const serverTestsWorkflow = readFileSync(
  new URL('../../.github/workflows/server-tests.yml', import.meta.url),
  'utf8',
);

const diagnosticsBlock = serverTestsWorkflow.match(
  /- name: Coverage failure diagnostics[\s\S]*?- name: Preserve exact coverage failure evidence/,
)?.[0] ?? '';

assert.notEqual(
  diagnosticsBlock,
  '',
  'Server Tests must retain the coverage-failure diagnostics step before preserving coverage artifacts',
);
assert.match(
  diagnosticsBlock,
  /for report in coverage\/coverage-final\.json coverage\/browser-coverage-final\.json/,
  'coverage diagnostics must attempt both server and browser Istanbul reports',
);
assert.match(
  diagnosticsBlock,
  /if ! node scripts\/ci\/coverage_diagnostics\.mjs "\$report"; then[\s\S]*?::warning::coverage diagnostics could not inspect \$report[\s\S]*?fi/,
  'one unreadable coverage report must not abort diagnostics before the other report is inspected',
);
assert.doesNotMatch(
  diagnosticsBlock,
  /\n\s+node scripts\/ci\/coverage_diagnostics\.mjs "\$report"\s*\n/,
  'coverage diagnostics must not invoke the helper as an unguarded bash -e command',
);

console.log('✓ coverage-failure diagnostics remain complete when one Istanbul report is unreadable');
