import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const serverTestsWorkflow = readFileSync(
  new URL('../../.github/workflows/server-tests.yml', import.meta.url),
  'utf8',
);

assert.match(
  serverTestsWorkflow,
  /- name: Install Playwright \(chromium for coverage\)\r?\n\s+timeout-minutes: 10\r?\n\s+run: npx playwright install chromium --with-deps/,
  'the browser-coverage runtime install must fail closed within ten minutes instead of holding the required job indefinitely',
);
assert.match(
  serverTestsWorkflow,
  /- name: Install Playwright \(chromium\)\r?\n\s+timeout-minutes: 10\r?\n\s+run: npx playwright install chromium --with-deps/,
  'the cloud-e2e runtime install must fail closed within ten minutes instead of holding the required job indefinitely',
);

console.log('✓ Playwright installation timeout contract passed');
