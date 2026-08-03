import { test, expect } from '@playwright/test';

test('invalid editor save remains focusable while activation stays blocked', async ({ page }) => {
  await page.goto('./');
  const initialTaskCount = await page.locator('tbody tr[data-task-id]').count();

  await page.getByRole('button', { name: '최상위 작업 추가' }).click();
  const editor = page.locator('.editor-panel');
  const saveButton = editor.getByRole('button', { name: '저장', exact: true });

  await expect(editor).toBeVisible();
  await expect(saveButton).toBeEnabled();
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).toHaveAttribute(
    'title',
    '입력값을 올바르게 수정해야 저장할 수 있습니다.',
  );

  await saveButton.focus();
  await expect(saveButton).toBeFocused();
  await saveButton.click();

  await expect(editor).toBeVisible();
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount);
  await expect(page.locator('#editor-errors')).not.toHaveText('');

  await page.getByTestId('editor-phase').fill('P9000.접근성 검증');
  await expect(saveButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).toHaveAttribute('title', '저장 (Enter)');

  await saveButton.click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount + 1);
});
