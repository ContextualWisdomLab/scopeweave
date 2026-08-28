import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dependencyWorkflow = readFileSync(
  new URL('../../.github/workflows/dependency-review.yml', import.meta.url),
  'utf8',
);

assert.match(
  dependencyWorkflow,
  /compare\/\$\{base_ref_encoded\}\.\.\.\$\{HEAD_SHA\}/,
  'dependency review resolves the PR merge base from the named base ref and exact contributor head',
);
assert.match(
  dependencyWorkflow,
  /\.merge_base_commit\.sha\s*\|\s*select\(test\("\^\[0-9a-f\]\{40\}\$"\)\)/,
  'dependency review validates the compare API merge-base SHA before publishing it',
);
assert.match(
  dependencyWorkflow,
  /echo "base_sha=\$BASE_SHA" >>"\$GITHUB_OUTPUT"/,
  'dependency review publishes the validated merge base for the dependency action',
);
assert.match(
  dependencyWorkflow,
  /base-ref: \$\{\{ steps\.dependency_review_support\.outputs\.base_sha \}\}/,
  'dependency-review-action compares from the validated merge base',
);

console.log('dependency review merge-base contract passed');
