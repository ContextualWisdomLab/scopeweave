import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const scripts = packageJson.scripts || {};
const serverWorkflow = readFileSync(new URL('../../.github/workflows/server-tests.yml', import.meta.url), 'utf8');
const publicApp = readFileSync(new URL('../../server/app.mjs', import.meta.url), 'utf8');
const applicationRoutes = readFileSync(new URL('../../server/application_routes.mjs', import.meta.url), 'utf8');

assert.match(
  serverWorkflow,
  /npm run test:coverage/,
  'server CI invokes the exact coverage producer',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/application_routes\.mjs/,
  'the protected application route graph remains owned-production coverage',
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
assert.doesNotMatch(
  publicApp,
  /app\.route\(\s*['"]\/['"]\s*,\s*applicationRoutes\s*\)/,
  'the public app does not mount the protected graph via app.route, which would first-match unsigned Stripe or skip abuse-control middleware',
);
assert.match(
  publicApp,
  /applicationRoutes\.routes\.filter\([\s\S]*method === ['"]POST['"][\s\S]*path === ['"]\/api\/stripe\/webhook['"][\s\S]*app\.on\(route\.method, route\.path, secureCopiedHandler\(route\)\)/,
  'the public app preserves the protected route graph while excluding the historical Stripe handler',
);
assert.match(
  publicApp,
  /verifyStripeWebhookRequest/,
  'the public Stripe webhook uses the raw-body HMAC verifier',
);
assert.match(
  applicationRoutes,
  /verifyStripeWebhookRequest/,
  'the protected Stripe route is also fail-closed so a direct mount cannot escalate plan',
);
assert.doesNotMatch(
  applicationRoutes,
  /checkout\.session\.completed[\s\S]{0,500}UPDATE orgs SET plan = 'pro'/,
  'checkout.session.completed JSON is never authority to upgrade orgs.plan',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
  'the Clearfolio signal and HTTP failure regression executes under c8',
);

console.log('coverage script contract passed');
