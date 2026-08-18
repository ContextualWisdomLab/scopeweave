import { test, expect } from './coverage-test.js';

const seededHierarchy = [
  { id: '1', depth: 1 },
  { id: '2', depth: 2 },
  { id: '3', depth: 3 },
  { id: '4', depth: 2 },
  { id: '5', depth: 1 },
  { id: '6', depth: 2 },
];

test.describe('getTaskSubtreeRange function tests', () => {
  test('should return correct range for root task, sub task and non-existent task', async ({ page }) => {
    await page.addInitScript((tasks) => {
      localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
        projectName: 'Subtree range regression',
        baseDate: '2026-08-19',
        tasks,
      }));
    }, seededHierarchy);

    await page.goto('/');

    const result = await page.evaluate(() => ({
      rootNodeRange: window.getTaskSubtreeRange('1'),
      leafNodeRange: window.getTaskSubtreeRange('3'),
      middleNodeRange: window.getTaskSubtreeRange('2'),
      nonExistentNodeRange: window.getTaskSubtreeRange('99'),
    }));

    expect(result.rootNodeRange).toEqual({ startIndex: 0, endIndex: 3 });
    expect(result.leafNodeRange).toEqual({ startIndex: 2, endIndex: 2 });
    expect(result.middleNodeRange).toEqual({ startIndex: 1, endIndex: 2 });
    expect(result.nonExistentNodeRange).toBeNull();
  });
});
