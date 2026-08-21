import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../../.github/workflows/codeql-required.yml', import.meta.url),
  'utf8',
);

assert.match(
  workflow,
  /^  pull_request:\r?\n  push:/m,
  'CodeQL Required must run on stacked pull requests regardless of their base branch',
);
assert.doesNotMatch(
  workflow,
  /\bpull_request_target\s*:/,
  'CodeQL Required must retain the unprivileged pull_request trust boundary',
);

console.log('✓ required CodeQL covers develop-bound and stacked pull requests');
