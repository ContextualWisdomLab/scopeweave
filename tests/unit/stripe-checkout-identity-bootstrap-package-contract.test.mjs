import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
));

const behaviorTest = 'node tests/unit/stripe-checkout-identity-bootstrap.test.mjs';
const productionInclude = '--include=server/stripe_checkout_identity_bootstrap.mjs';

assert.match(
  packageJson.scripts['test:unit'],
  new RegExp(behaviorTest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  'normal unit CI must execute the Checkout identity bootstrap regression',
);
assert.match(
  packageJson.scripts['test:coverage'],
  new RegExp(productionInclude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  'canonical coverage must instrument the Checkout identity bootstrap module',
);
assert.match(
  packageJson.scripts['test:coverage:cases'],
  new RegExp(behaviorTest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  'canonical coverage cases must execute the Checkout identity bootstrap regression',
);

console.log('✓ Checkout identity bootstrap package registration contract passed');
