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
