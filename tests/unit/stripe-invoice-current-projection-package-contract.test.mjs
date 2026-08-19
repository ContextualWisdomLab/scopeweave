import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const scripts = packageJson.scripts;

assert.match(
  scripts['test:coverage'],
  /--include=server\/stripe_invoice_current_projection\.mjs/,
  'the current Stripe Invoice projection remains in owned production coverage',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/stripe-invoice-current-projection\.test\.mjs/,
  'the current Stripe Invoice projection regression executes under c8',
);
assert.match(
  scripts['test:unit'],
  /tests\/unit\/stripe-invoice-current-projection\.test\.mjs/,
  'normal unit CI executes the current Stripe Invoice projection regression',
);

console.log('✓ Stripe Invoice projection package contract passed');
