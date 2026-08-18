import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';

const expectedBrowserSources = new Set(['/app.js', '/cloud-sync.js']);

const isRequiredSource = (url) => {
  try {
    return expectedBrowserSources.has(decodeURIComponent(new URL(url).pathname));
  } catch {
    return false;
  }
};

const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const coverageEnabled = process.env.SCOPEWEAVE_BROWSER_COVERAGE === '1';
    if (!coverageEnabled) {
      await use(page);
      return;
    }

    const coverageDirectory = process.env.SCOPEWEAVE_BROWSER_COVERAGE_DIR;
    if (!coverageDirectory) {
      throw new Error('SCOPEWEAVE_BROWSER_COVERAGE_DIR is required when browser coverage is enabled.');
    }

    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    let coverageEntries;
    try {
      await use(page);
    } finally {
      coverageEntries = await page.coverage.stopJSCoverage();
    }

    const entries = coverageEntries.filter((entry) => isRequiredSource(entry.url));
    await mkdir(coverageDirectory, { recursive: true });
    const identity = [testInfo.testId, testInfo.retry, testInfo.workerIndex].join(':');
    const digest = createHash('sha256').update(identity).digest('hex');
    await writeFile(
      path.join(coverageDirectory, `${digest}.json`),
      `${JSON.stringify({ entries })}\n`,
      'utf8',
    );
  },
});

export { test, expect };
