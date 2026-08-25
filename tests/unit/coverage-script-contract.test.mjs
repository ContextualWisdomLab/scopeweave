import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const scripts = packageJson.scripts || {};
const serverWorkflow = readFileSync(new URL('../../.github/workflows/server-tests.yml', import.meta.url), 'utf8');
const publicApp = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');
const routeImportSeam = readFileSync(new URL('../../server/app_routes.mjs', import.meta.url), 'utf8');
const applicationRoutes = readFileSync(new URL('../../server/application_routes.mjs', import.meta.url), 'utf8');
const applicationRoutesCore = readFileSync(new URL('../../server/application_routes_core.mjs', import.meta.url), 'utf8');

assert.match(
  serverWorkflow,
  /npm run test:coverage/,
  'server CI invokes the exact coverage producer',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/app\.mjs/,
  'the public transport-peer security envelope remains owned-production coverage',
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
