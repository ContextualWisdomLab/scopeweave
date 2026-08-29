import { test as base } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const coverageEnabled = process.env.SCOPEWEAVE_BROWSER_COVERAGE === '1';
const coverageDirectory = path.resolve('coverage/browser');

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    if (!coverageEnabled) {
      await use(page);
      return;
    }

    await page.coverage.startJSCoverage({ reportAnonymousScripts: false });
    try {
      await use(page);
    } finally {
      const entries = await page.coverage.stopJSCoverage();
      await mkdir(coverageDirectory, { recursive: true });
      const filename = `${testInfo.workerIndex}-${testInfo.testId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}.json`;
      await writeFile(path.join(coverageDirectory, filename), JSON.stringify(entries));
    }
  },
});

export { expect } from '@playwright/test';
