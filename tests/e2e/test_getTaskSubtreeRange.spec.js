import { test, expect } from './coverage-test.js';

test.describe('getTaskSubtreeRange function tests', () => {
  test('should return correct range for root task, sub task and non-existent task', async ({ page }) => {
    await page.goto('/');

    // app.js intentionally keeps planner internals in the classic-script global
    // lexical environment instead of exporting them on window. Serve this test
    // probe from the same origin so CSP `script-src 'self'` allows it while the
    // additional classic script still shares app.js's global lexical environment.
    const probeRoute = '**/__scopeweave-subtree-range-probe.js';
    await page.route(
      probeRoute,
      (route) => route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: `
          state.tasks = [
            { id: '1', depth: 1 },
            { id: '2', depth: 2 },
            { id: '3', depth: 3 },
            { id: '4', depth: 2 },
            { id: '5', depth: 1 },
            { id: '6', depth: 2 }
          ];
          invalidateTaskIndexCache();
          window.__scopeweaveSubtreeRangeResult = {
            rootNodeRange: getTaskSubtreeRange('1'),
            leafNodeRange: getTaskSubtreeRange('3'),
            middleNodeRange: getTaskSubtreeRange('2'),
            nonExistentNodeRange: getTaskSubtreeRange('99')
          };
        `,
      }),
      { times: 1 },
    );

    try {
      await page.addScriptTag({ url: '/__scopeweave-subtree-range-probe.js' });
    } finally {
      await page.unroute(probeRoute);
    }

    const result = await page.evaluate(() => window.__scopeweaveSubtreeRangeResult);
    await page.evaluate(() => { delete window.__scopeweaveSubtreeRangeResult; });

    expect(result.rootNodeRange).toEqual({ startIndex: 0, endIndex: 3 });
    expect(result.leafNodeRange).toEqual({ startIndex: 2, endIndex: 2 });
    expect(result.middleNodeRange).toEqual({ startIndex: 1, endIndex: 2 });
    expect(result.nonExistentNodeRange).toBeNull();
  });
});
