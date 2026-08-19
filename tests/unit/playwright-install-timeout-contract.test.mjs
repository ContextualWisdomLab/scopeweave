import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const serverTestsWorkflow = readFileSync(
  new URL('../../.github/workflows/server-tests.yml', import.meta.url),
  'utf8',
);

assert.match(
  serverTestsWorkflow,
  /- name: Install Playwright \(chromium for coverage\)\r?\n\s+timeout-minutes: 10\r?\n\s+run: npx playwright install chromium(?:\r?\n|$)/,
  'the browser-coverage runtime install must be bounded and avoid apt-backed --with-deps network work in the required lane',
);
assert.match(
  serverTestsWorkflow,
  /- name: Install Playwright \(chromium\)\r?\n\s+timeout-minutes: 10\r?\n\s+run: npx playwright install chromium(?:\r?\n|$)/,
  'the cloud-e2e runtime install must be bounded and avoid apt-backed --with-deps network work in the required lane',
);
assert.doesNotMatch(
  serverTestsWorkflow,
  /npx playwright install chromium --with-deps/,
  'required Server Tests must not re-enter the Ubuntu package-manager path that can stall on runner mirror availability',
);

console.log('✓ Playwright installation reliability contract passed');
