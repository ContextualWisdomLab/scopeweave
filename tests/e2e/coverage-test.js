import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';

const expectedBrowserSources = new Set(['/app.js', '/cloud-sync.js', '/modal-controls.js']);

const requiredSourcePath = (url) => {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    return expectedBrowserSources.has(pathname) ? pathname : null;
  } catch {
    return null;
  }
};

const isRequiredSource = (url) => requiredSourcePath(url) !== null;

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

    const servedSourceSha256 = Object.create(null);
    const responseEvidence = [];
    const responseListener = (response) => {
      const sourcePath = requiredSourcePath(response.url());
      if (!sourcePath || response.status() !== 200) return;
      responseEvidence.push((async () => {
        const body = await response.body();
        const sourceDigest = createHash('sha256').update(body).digest('hex');
        const previousDigest = servedSourceSha256[sourcePath];
        if (previousDigest && previousDigest !== sourceDigest) {
          throw new Error(`Browser received inconsistent bytes for ${sourcePath}.`);
        }
        servedSourceSha256[sourcePath] = sourceDigest;
      })());
    };
    page.on('response', responseListener);

    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    let coverageEntries;
    try {
      await use(page);
    } finally {
      coverageEntries = await page.coverage.stopJSCoverage();
      page.off('response', responseListener);
      await Promise.all(responseEvidence);
    }

    const entries = coverageEntries.filter((entry) => isRequiredSource(entry.url));
    await mkdir(coverageDirectory, { recursive: true });
    const identity = [testInfo.testId, testInfo.retry, testInfo.workerIndex].join(':');
    const digest = createHash('sha256').update(identity).digest('hex');
    await writeFile(
      path.join(coverageDirectory, `${digest}.json`),
      `${JSON.stringify({ entries, servedSourceSha256 })}\n`,
      'utf8',
    );
  },
});

export { test, expect };
