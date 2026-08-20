import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './stripe-entitlement-claim-head-integrity.test.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const scripts = packageJson.scripts;

assert.match(
  scripts['test:coverage'],
  /--include=server\/stripe_entitlement_claim_ledger\.mjs/,
  'the transactional Stripe entitlement claim ledger remains in owned production coverage',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/stripe-entitlement-claim-ledger\.test\.mjs/,
  'the transactional Stripe entitlement claim regression executes under c8',
);
assert.match(
  scripts['test:unit'],
  /tests\/unit\/stripe-entitlement-claim-ledger\.test\.mjs/,
  'normal unit CI executes the transactional Stripe entitlement claim regression',
);

console.log('✓ Stripe entitlement claim package contract passed');
