import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const scripts = packageJson.scripts;

assert.equal(scripts.coverage, 'npm run test:coverage');
assert.match(
  scripts['test:coverage'],
  /\bc8\b.*--reporter=json.*npm run test:coverage:cases/,
);
assert.match(scripts['test:coverage'], /--include=server\/attachment_status\.mjs/);
assert.match(scripts['test:coverage'], /--include=server\/clearfolio\.mjs/);
assert.match(
  scripts['test:coverage:cases'],
  /tests\/unit\/clearfolio-status-signal\.test\.mjs/,
);
assert.doesNotMatch(
  scripts['test:coverage:cases'],
  /npm run (?:coverage|test:coverage)(?:\s|$)/,
);

console.log('✓ coverage script contract tests passed');
