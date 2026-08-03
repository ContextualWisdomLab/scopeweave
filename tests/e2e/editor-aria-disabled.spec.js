import { test, expect } from '@playwright/test';

test.describe('inline editor aria-disabled submit', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('');
  });

  test('keeps invalid save focusable and blocks click persistence with inline feedback', async ({ page }) => {
    const initialRows = await page.locator('tbody tr[data-task-id]').count();
    const saveButton = page.getByRole('button', { name: '저장', exact: true });
    const errors = page.locator('#editor-errors');

    await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    await expect(saveButton).not.toBeDisabled();
    await saveButton.focus();
    await expect(saveButton).toBeFocused();
    await saveButton.click();

    await expect(errors).toHaveAttribute('aria-live', 'polite');
    await expect(errors).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialRows);
  });

  test('blocks keyboard activation without creating a task', async ({ page }) => {
    const initialRows = await page.locator('tbody tr[data-task-id]').count();
    const saveButton = page.getByRole('button', { name: '저장', exact: true });

    await saveButton.focus();
    await page.keyboard.press('Enter');

    await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialRows);
  });
});
