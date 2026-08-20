import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflows = [
  ['CodeQL Required', '../../.github/workflows/codeql-required.yml'],
  ['CodeQL publisher', '../../.github/workflows/codeql.yml'],
];

for (const [label, relativePath] of workflows) {
  const workflow = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  assert.match(
    workflow,
    /^on:\r?\n  pull_request:\r?\n  push:/m,
    `${label} must run on stacked pull requests regardless of their base branch`,
  );
  assert.doesNotMatch(
    workflow,
    /\bpull_request_target\s*:/,
    `${label} must retain the unprivileged pull_request trust boundary`,
  );
}

console.log('✓ CodeQL workflows cover develop-bound and stacked pull requests');
