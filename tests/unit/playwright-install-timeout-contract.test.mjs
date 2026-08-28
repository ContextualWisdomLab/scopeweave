import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const serverTestsWorkflow = readFileSync(
  new URL('../../.github/workflows/server-tests.yml', import.meta.url),
  'utf8',
);
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const cloudE2eScript = packageJson.scripts?.['test:e2e:cloud'] ?? '';

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
  /npx playwright install[^\r\n]*--with-deps/,
  'required Server Tests must not re-enter the Ubuntu package-manager path that can stall on runner mirror availability',
);
assert.equal(
  cloudE2eScript,
  'playwright test tests/e2e/cloud.spec.js tests/e2e/toast-accessibility.spec.js',
  'the targeted cloud script must remain available for focused local regression work without performing its own browser install',
);
assert.match(
  serverTestsWorkflow,
  /- name: Cloud UI e2e\r?\n\s+run: npm run test:e2e(?:\r?\n|$)/,
  'the required cloud-e2e job must execute the complete Playwright suite so newly added regressions cannot be silently omitted',
);
assert.doesNotMatch(
  serverTestsWorkflow,
  /- name: Cloud UI e2e\r?\n\s+run: npm run test:e2e:cloud(?:\r?\n|$)/,
  'the required cloud-e2e job must not use the historical subset-only script',
);

console.log('✓ Playwright installation reliability contract passed');
