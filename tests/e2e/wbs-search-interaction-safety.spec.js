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

  test('disables hierarchy changes while filtered rows hide context', async ({ page }) => {
    const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
    await search.fill('단계작업계획');

    const rows = page.locator('tbody tr[data-task-id]');
    await expect(page.getByRole('button', { name: '최상위 작업 추가' })).toHaveAttribute('aria-disabled', 'true');
    await expect(rows.first().locator('button[data-action="toggle"]')).toBeDisabled();

    const addChild = rows.first().getByRole('button', { name: /하위 추가 -/ });
    await expect(addChild).toHaveAttribute('aria-disabled', 'true');
    await addChild.dispatchEvent('click');
    await expect(page.locator('.editor-panel')).toHaveCount(0);
  });

  test('keeps an open editor visible by pausing search changes until editing finishes', async ({ page }) => {
    const firstRow = page.locator('tbody tr[data-task-id]').first();
    await firstRow.getByRole('button', { name: /편집 -/ }).click();

    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'WBS 작업 검색' })).toBeDisabled();
  });

  test('blocks create actions while filtered context could hide the editor anchor', async ({ page }) => {
    const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
    await search.fill('단계작업계획');

    await expect(page.getByRole('button', { name: '최상위 작업 추가' })).toBeDisabled();
    await expect(page.locator('tbody tr[data-task-id]').first().getByRole('button', { name: /하위 추가 -/ })).toBeDisabled();
  });
});
