import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const scripts = packageJson.scripts || {};
const serverWorkflow = readFileSync(new URL('../../.github/workflows/server-tests.yml', import.meta.url), 'utf8');
const dependencyWorkflow = readFileSync(new URL('../../.github/workflows/dependency-review.yml', import.meta.url), 'utf8');
const publicApp = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');
const routeImportSeam = readFileSync(new URL('../../server/app_routes.mjs', import.meta.url), 'utf8');
const applicationRoutes = readFileSync(new URL('../../server/application_routes.mjs', import.meta.url), 'utf8');
const applicationRoutesCore = readFileSync(new URL('../../server/application_routes_core.mjs', import.meta.url), 'utf8');
const rateLimitModule = readFileSync(new URL('../../server/rate_limit.mjs', import.meta.url), 'utf8');

assert.match(
  serverWorkflow,
  /npm run test:coverage/,
  'server CI invokes the exact coverage producer',
);
assert.equal(
  (serverWorkflow.match(/run:\s*npm run test:api/g) || []).length,
  0,
  'server CI does not execute the API suite separately when owned coverage already executes it',
);
const exactCheckoutRepository =
  "repository: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name || github.repository }}";
const exactCheckoutRef =
  "ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
assert.equal(
  serverWorkflow.split(exactCheckoutRepository).length - 1,
  2,
  'both server CI jobs bind checkout to the submitted repository on pull requests',
);
assert.equal(
  serverWorkflow.split(exactCheckoutRef).length - 1,
  2,
  'both server CI jobs bind checkout to the exact submitted head SHA on pull requests',
);
assert.equal(
  (serverWorkflow.match(/- name: Verify exact checkout revision/g) || []).length,
  2,
  'both server CI jobs attest the actual checkout revision before executing repository code',
);
assert.equal(
  (serverWorkflow.match(/actual_head_sha="\$\(git rev-parse HEAD\)"/g) || []).length,
  2,
  'both server CI jobs measure the actual checked-out revision',
);
assert.equal(
  (serverWorkflow.match(/test "\$actual_head_sha" = "\$EXPECTED_HEAD_SHA"/g) || []).length,
  2,
  'both server CI jobs fail closed when checkout identity differs from the expected exact head',
);
assert.equal(
  dependencyWorkflow.split(exactCheckoutRepository).length - 1,
  1,
  'dependency review binds checkout to the submitted repository on pull requests',
);
assert.equal(
  dependencyWorkflow.split(exactCheckoutRef).length - 1,
  1,
  'dependency review binds checkout to the exact submitted head SHA on pull requests',
);
assert.equal(
  (dependencyWorkflow.match(/- name: Verify exact checkout revision/g) || []).length,
  1,
  'dependency review attests the actual checkout revision before executing the gate',
);
assert.match(
  dependencyWorkflow,
  /BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/,
  'dependency review starts from the named base branch rather than stale event base SHA evidence',
);
assert.doesNotMatch(
  dependencyWorkflow,
  /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  'dependency review does not trust the historical event base SHA as the live comparison base',
);
assert.match(
  dependencyWorkflow,
  /branches\/\$\{base_ref_encoded\}/,
  'dependency review independently resolves the current base branch tip through the GitHub API',
);
assert.match(
  dependencyWorkflow,
  /echo "base_sha=\$BASE_SHA" >>"\$GITHUB_OUTPUT"/,
  'dependency review publishes the independently resolved live base SHA for the action comparison',
);
assert.match(
  dependencyWorkflow,
  /base-ref: \$\{\{ steps\.dependency_review_support\.outputs\.base_sha \}\}/,
  'dependency-review-action receives the independently resolved live base SHA explicitly',
);
assert.match(
  dependencyWorkflow,
  /head-ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  'dependency-review-action receives the exact contributor head SHA explicitly',
);
assert.doesNotMatch(
  dependencyWorkflow,
  /Dependency review is unavailable[\s\S]{0,300}supported=false[\s\S]{0,100}exit 0/,
  'dependency review never converts unavailable pull-request comparison evidence into a green skip',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/app\.mjs/,
  'the public transport-peer security envelope remains owned-production coverage',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/rate_limit\.mjs/,
  'the shared authoritative rate-limit implementation remains owned-production coverage',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/application_routes\.mjs/,
  'the shared security boundary remains owned-production coverage',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/application_routes_core\.mjs/,
  'the protected application implementation remains owned-production coverage',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/stripe_webhook\.mjs/,
  'the Stripe webhook verifier is owned-production coverage',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/stripe-webhook-boundary\.test\.mjs/,
  'the raw-body Stripe trust-boundary regression executes under c8',
);
assert.match(
  scripts['test:api'],
  /tests\/api\/stripe-webhook\.test\.mjs/,
  'the public Stripe webhook entitlement regression executes in normal API CI',
);
assert.match(
  publicApp,
  /await import\(['"]\.\/app_routes\.mjs['"]\)/,
  'the public app loads the guarded route graph only after establishing the authoritative limiter envelope',
);
assert.match(
  publicApp,
  /import\s*\{\s*createRateLimitMiddleware,\s*createRateLimitObservability,?\s*\}\s*from\s*['"]\.\/rate_limit\.mjs['"]/,
  'the public and shared boundaries consume the same authoritative rate-limit implementation',
);
assert.doesNotMatch(
  publicApp,
  /function\s+(?:parseSafeIntegerSetting|canonicalIp|rateLimitBucket)\s*\(/,
  'the public envelope does not fork validation, client identity, or bucket semantics from rate_limit.mjs',
);
assert.match(
  publicApp,
  /app\.use\(\s*['"]\*['"]\s*,\s*createRateLimitMiddleware\(rateLimitObservability\)\s*\)/,
  'the public envelope installs the shared limiter before mounting the guarded route graph',
);
assert.match(
  rateLimitModule,
  /Math\.max\(1,\s*Math\.ceil\(\(bucket\.resetAt - now\) \/ 1000\)\)/,
  'the single limiter source preserves a positive Retry-After boundary',
);
assert.match(
  publicApp,
  /app\.route\(\s*['"]\/['"]\s*,\s*routeApp\s*\)/,
  'the transport-peer-aware limiter wraps the supported shared route graph',
);
assert.match(
  routeImportSeam,
  /export \{ app \} from ['"]\.\/application_routes\.mjs['"]/,
  'the transitional import seam delegates to the single supported shared application boundary',
);
assert.match(
  applicationRoutes,
  /app\.use\(OIDC_ROUTE_PREFIX, failClosedWhenOidcIsUnconfigured\)[\s\S]*app\.use\(INVITE_ACCEPT_PATH, bindInviteToAuthenticatedIdentity\)[\s\S]*app\.use\(MEMBERS_PATH, redactPendingInviteTokens\)[\s\S]*app\.route\(\s*['"]\/['"]\s*,\s*coreRoutes\s*\)/,
  'shared OIDC and invitation controls wrap the implementation graph before it is mounted',
);
assert.match(
  applicationRoutesCore,
  /verifyStripeWebhookRequest/,
  'the protected Stripe route is fail-closed so every supported mount verifies raw-body authenticity',
);
assert.doesNotMatch(
  applicationRoutesCore,
  /checkout\.session\.completed[\s\S]{0,500}UPDATE orgs SET plan = 'pro'/,
  'checkout.session.completed JSON is never authority to upgrade orgs.plan',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
  'the Clearfolio signal and HTTP failure regression executes under c8',
);

console.log('coverage script contract passed');
