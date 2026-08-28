import { test, expect } from '@playwright/test';

test('filtered WBS rows cannot mutate progress that can remove them from the visible result set', async ({ page }) => {
  await page.goto('./');

  const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
  await search.fill('단계작업계획');

  const visibleRows = page.locator('tbody tr[data-task-id]');
  await expect(visibleRows).toHaveCount(3);

  const progressFields = visibleRows.locator('select[data-inline-progress]');
  await expect(progressFields).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    const progressField = progressFields.nth(index);
    await expect(progressField).toBeDisabled();
    await expect(progressField).toHaveAttribute('aria-disabled', 'true');
    await expect(progressField).toHaveAttribute('title', '검색 중에는 실적진척상태를 변경할 수 없습니다. 검색을 먼저 지워주세요.');
  }

  await page.getByRole('button', { name: '검색 지우기' }).click();

  const restoredProgressFields = page.locator('tbody tr[data-task-id] select[data-inline-progress]');
  await expect(restoredProgressFields.first()).toBeEnabled();
  await expect(restoredProgressFields.first()).not.toHaveAttribute('aria-disabled', 'true');
  await expect(restoredProgressFields.first()).not.toHaveAttribute('title', /.+/);
});

test('filtered WBS rows cannot open an editor that can remove a row from the visible result set', async ({ page }) => {
  await page.goto('./');

  const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
  await search.fill('단계작업계획');

  const visibleRows = page.locator('tbody tr[data-task-id]');
  await expect(visibleRows).toHaveCount(3);

  const editButtons = visibleRows.locator('button[data-action="edit"]');
  await expect(editButtons).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    const editButton = editButtons.nth(index);
    await expect(editButton).toHaveAttribute('aria-disabled', 'true');
    await expect(editButton).toHaveAttribute('title', '검색 중에는 작업을 편집할 수 없습니다. 검색을 먼저 지워주세요.');
  }

  await visibleRows.first().locator('td').nth(1).click();
  await expect(page.locator('.editor-panel')).toHaveCount(0);

  await page.getByRole('button', { name: '검색 지우기' }).click();

  const restoredEditButton = page.locator('tbody tr[data-task-id] button[data-action="edit"]').first();
  await expect(restoredEditButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(restoredEditButton).toHaveAttribute('title', /편집/);
});
