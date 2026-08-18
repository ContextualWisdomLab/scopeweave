import { test, expect } from './coverage-test.js';

test.describe('getTaskSubtreeRange function tests', () => {
  test('should return correct range for root task, sub task and non-existent task', async ({ page }) => {
    await page.goto('/');

    // app.js intentionally keeps planner internals in the classic-script global
    // lexical environment instead of exporting them on window. Execute this
    // test probe as another classic script so it shares that lexical environment
    // without rewriting the served production bytes that coverage attests.
    await page.addScriptTag({
      content: `
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
    });

    const result = await page.evaluate(() => window.__scopeweaveSubtreeRangeResult);
    await page.evaluate(() => { delete window.__scopeweaveSubtreeRangeResult; });

    expect(result.rootNodeRange).toEqual({ startIndex: 0, endIndex: 3 });
    expect(result.leafNodeRange).toEqual({ startIndex: 2, endIndex: 2 });
    expect(result.middleNodeRange).toEqual({ startIndex: 1, endIndex: 2 });
    expect(result.nonExistentNodeRange).toBeNull();
  });
});
