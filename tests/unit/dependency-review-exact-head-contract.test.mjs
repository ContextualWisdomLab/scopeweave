import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../../.github/workflows/dependency-review.yml', import.meta.url),
  'utf8',
);

assert.match(
  workflow,
  /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  'Dependency Review must check out the exact contributor head on pull requests',
);
assert.match(
  workflow,
  /EXPECTED_CHECKOUT_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  'Dependency Review must bind runtime checkout verification to the expected exact head',
);
assert.match(
  workflow,
  /git rev-parse HEAD[\s\S]*?test "\$actual_sha" = "\$EXPECTED_CHECKOUT_SHA"/,
  'Dependency Review must fail closed when the actual checkout differs from the expected head',
);
assert.match(
  workflow,
  /BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/,
  'Dependency Review must resolve the current named protected base rather than trust a PR base snapshot',
);
assert.doesNotMatch(
  workflow,
  /github\.event\.pull_request\.base\.sha/,
  'Dependency Review must not treat pull_request.base.sha as the live protected base tip',
);
assert.match(
  workflow,
  /git ls-remote --exit-code origin "refs\/heads\/\$BASE_REF"/,
  'Dependency Review must independently resolve the live base branch tip',
);
assert.match(
  workflow,
  /mapfile -t live_base_matches <<<"\$result"/,
  'Dependency Review must materialize every live-base ls-remote match before parsing one',
);
assert.match(
  workflow,
  /test "\$\{#live_base_matches\[@\]\}" -eq 1/,
  'Dependency Review must fail closed unless live-base resolution yields exactly one ref',
);
assert.match(
  workflow,
  /read -r live_base_sha live_base_ref extra <<<"\$\{live_base_matches\[0\]\}"/,
  'Dependency Review must parse the sole validated live-base result',
);
assert.doesNotMatch(
  workflow,
  /read -r live_base_sha live_base_ref extra <<<"\$result"/,
  'Dependency Review must not inspect only the first line of an unchecked multi-line result',
);

const ancestryCompareEndpoint = '/repos/${REPOSITORY}/compare/${BASE_SHA}...${HEAD_SHA}';
const dependencyGraphCompareEndpoint = '/repos/${REPOSITORY}/dependency-graph/compare/${BASE_SHA}...${HEAD_SHA}';
const ancestryCheckIndex = workflow.indexOf(ancestryCompareEndpoint);
const dependencyGraphCheckIndex = workflow.indexOf(dependencyGraphCompareEndpoint);
assert.notEqual(
  ancestryCheckIndex,
  -1,
  'Dependency Review must verify the exact head relationship to the independently resolved live base',
);
assert.notEqual(
  dependencyGraphCheckIndex,
  -1,
  'Dependency Review must retain an explicit dependency-graph support check',
);
assert.ok(
  ancestryCheckIndex < dependencyGraphCheckIndex,
  'Dependency Review must reject a stale/diverged head before interpreting dependency-graph differences',
);
assert.match(
  workflow,
  /comparison_status="\$\(jq -er '\.status' "\$relationship_file"\)"/,
  'Dependency Review must parse the authenticated compare-commits relationship fail closed',
);
assert.match(
  workflow,
  /if \[ "\$comparison_status" != "ahead" \] && \[ "\$comparison_status" != "identical" \]; then[\s\S]*?exit 1/,
  'Dependency Review must fail when the exact contributor head does not contain the live protected base',
);
assert.match(
  workflow,
  /base-ref: \$\{\{ steps\.resolve_live_base\.outputs\.base_sha \}\}/,
  'Dependency Review action must compare from the independently resolved live base SHA',
);
assert.match(
  workflow,
  /head-ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  'Dependency Review action must compare through the exact contributor-head SHA',
);
assert.doesNotMatch(
  workflow,
  /status" = "403"[\s\S]*?supported=false|status" = "404"[\s\S]*?supported=false/,
  'Dependency Review must not turn unavailable comparison evidence into a passing skip',
);
assert.match(
  workflow,
  /persist-credentials: false/,
  'Dependency Review checkout must not persist repository credentials',
);
assert.doesNotMatch(
  workflow,
  /\bpull_request_target\s*:/,
  'Dependency Review must remain on the unprivileged pull_request trust boundary',
);

console.log('✓ Dependency Review exact-head/live-base contract passed');
