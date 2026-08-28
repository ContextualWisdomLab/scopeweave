import { test, expect } from '@playwright/test';

test.describe('WBS search interaction safety', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
  });

  test('prevents drag reordering while filtered rows hide sibling context', async ({ page }) => {
    const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
    await search.fill('단계작업계획');

    const rows = page.locator('tbody tr[data-task-id]');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toHaveAttribute('draggable', 'false');
    await expect(rows.nth(1)).toHaveAttribute('draggable', 'false');
    await expect(rows.nth(2)).toHaveAttribute('draggable', 'false');
  });

  test('coalesces rapid search input before rerendering analytics', async ({ page }) => {
    await page.evaluate(() => {
      const analytics = window.ScopeWeaveAnalytics;
      const render = analytics.render;
      window.__scopeweaveRenderCount = 0;
      analytics.render = (...args) => {
        window.__scopeweaveRenderCount += 1;
        return render(...args);
      };
    });

    const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
    await search.pressSequentially('단계작업계획', { delay: 0 });

    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(3);
    expect(await page.evaluate(() => window.__scopeweaveRenderCount)).toBe(1);
  });

  test('blocks hierarchy changes while filtered rows hide context', async ({ page }) => {
    const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
    await search.fill('단계작업계획');

    const rows = page.locator('tbody tr[data-task-id]');
    const addRoot = page.getByRole('button', { name: '최상위 작업 추가' });
    const addChild = rows.first().getByRole('button', { name: /하위 추가 -/ });
    const deleteButton = rows.first().getByRole('button', { name: /삭제 -/ });

    await expect(addRoot).toHaveAttribute('aria-disabled', 'true');
    await expect(rows.first().locator('button[data-action="toggle"]')).toBeDisabled();
    await expect(addChild).toHaveAttribute('aria-disabled', 'true');
    await expect(deleteButton).toHaveAttribute('aria-disabled', 'true');

    await addChild.dispatchEvent('click');
    await expect(page.locator('#toast')).toContainText('검색 중에는 작업을 추가할 수 없습니다.');
    await expect(page.locator('.editor-panel')).toHaveCount(0);

    await addRoot.dispatchEvent('click');
    await expect(page.locator('#toast')).toContainText('검색 중에는 작업을 추가할 수 없습니다.');
    await expect(page.locator('.editor-panel')).toHaveCount(0);

    await deleteButton.dispatchEvent('click');
    await expect(page.locator('#toast')).toContainText('검색 중에는 작업을 삭제할 수 없습니다.');
    await expect(rows).toHaveCount(3);
  });

  test('keeps an open editor visible by pausing search changes until editing finishes', async ({ page }) => {
    const firstRow = page.locator('tbody tr[data-task-id]').first();
    await firstRow.getByRole('button', { name: /편집 -/ }).click();

    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'WBS 작업 검색' })).toBeDisabled();
  });

  test('keeps the depth-limit explanation actionable when search is inactive', async ({ page }) => {
    const leafAddChild = page.locator('tbody tr[data-task-id].depth-3').first().locator('button[data-action="add-child"]');

    await expect(leafAddChild).toHaveAttribute('aria-disabled', 'true');
    await leafAddChild.dispatchEvent('click');
    await expect(page.locator('#toast')).toContainText('최대 3단계까지만 추가할 수 있습니다.');
    await expect(page.locator('.editor-panel')).toHaveCount(0);
  });
});
