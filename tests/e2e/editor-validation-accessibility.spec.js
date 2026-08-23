import { test, expect } from '@playwright/test';

async function openRootEditor(page) {
  await page.getByRole('button', { name: '최상위 작업 추가' }).click();
  return page.locator('.editor-panel');
}

test.describe('editor validation accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
  });

  test('keeps an invalid save control focusable, described, and non-persisting', async ({ page }) => {
    const initialTaskCount = await page.locator('tbody tr[data-task-id]').count();
    const editor = await openRootEditor(page);
    const saveButton = editor.getByRole('button', { name: '저장', exact: true });

    await expect(saveButton).not.toHaveAttribute('disabled');
    await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    await expect(saveButton).toHaveAttribute('aria-describedby', 'editor-errors');

    await saveButton.focus();
    await expect(saveButton).toBeFocused();
    await saveButton.evaluate((button) => button.click());

    await expect(saveButton).toBeFocused();
    await expect(editor).toBeVisible();
    await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount);
  });

  test('saves the latest valid draft immediately by pointer activation', async ({ page }) => {
    const initialTaskCount = await page.locator('tbody tr[data-task-id]').count();
    const editor = await openRootEditor(page);
    const phaseInput = page.getByTestId('editor-phase');
    const saveButton = editor.getByRole('button', { name: '저장', exact: true });

    await phaseInput.fill('P9000.즉시 클릭');
    await saveButton.evaluate((button) => button.click());

    await expect(editor).toHaveCount(0);
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount + 1);
    await expect(page.locator('tbody tr[data-task-id]').filter({ hasText: 'P9000.즉시 클릭' })).toHaveCount(1);
  });

  test('saves the latest valid draft immediately with Enter', async ({ page }) => {
    const initialTaskCount = await page.locator('tbody tr[data-task-id]').count();
    const editor = await openRootEditor(page);
    const phaseInput = page.getByTestId('editor-phase');

    await phaseInput.fill('P9001.즉시 엔터');
    await phaseInput.press('Enter');

    await expect(editor).toHaveCount(0);
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount + 1);
    await expect(page.locator('tbody tr[data-task-id]').filter({ hasText: 'P9001.즉시 엔터' })).toHaveCount(1);
  });

  test('refreshes validation from the latest invalid draft before a stale enabled save can persist', async ({ page }) => {
    const initialTaskCount = await page.locator('tbody tr[data-task-id]').count();
    const editor = await openRootEditor(page);
    const phaseInput = page.getByTestId('editor-phase');
    const saveButton = editor.getByRole('button', { name: '저장', exact: true });

    await phaseInput.fill('temporarily valid');
    await expect(saveButton).not.toHaveAttribute('aria-disabled', 'true', { timeout: 1000 });

    await phaseInput.fill('');
    await saveButton.focus();
    await saveButton.evaluate((button) => button.click());

    await expect(saveButton).toBeFocused();
    await expect(editor).toBeVisible();
    await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    await expect(saveButton).toHaveAttribute('aria-describedby', 'editor-errors');
    await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount);
  });
});
