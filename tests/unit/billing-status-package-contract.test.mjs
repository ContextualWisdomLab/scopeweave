import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const scripts = packageJson.scripts;

assert.match(
  scripts['test:unit'],
  /tests\/unit\/billing-status-response\.test\.mjs/,
  'normal unit CI executes billing-status normalization regressions',
);
assert.match(
  scripts['test:coverage'],
  /--include=server\/billing_status_response\.mjs(?:\s|$)/,
  'owned billing-status normalization is included in c8 production coverage',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/billing-status-response\.test\.mjs/,
  'billing-status normalization regressions execute under c8',
);
assert.match(
  scripts['test:unit'],
  /tests\/unit\/billing-status-package-contract\.test\.mjs/,
  'normal unit CI executes the billing-status coverage-registration contract itself',
);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/billing-status-package-contract\.test\.mjs/,
  'canonical c8 cases execute the billing-status coverage-registration contract itself',
);

console.log('✓ billing status package/coverage contract passed');
