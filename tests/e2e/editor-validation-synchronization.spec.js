import { test, expect } from '@playwright/test';

async function openRootEditor(page) {
  await page.goto('./');
  const initialTaskCount = await page.locator('tbody tr[data-task-id]').count();
  await page.getByRole('button', { name: '최상위 작업 추가' }).click();
  const editor = page.locator('.editor-panel');
  const phaseInput = page.getByTestId('editor-phase');
  const saveButton = editor.getByRole('button', { name: '저장', exact: true });
  await expect(editor).toBeVisible();
  return { initialTaskCount, editor, phaseInput, saveButton };
}

test('valid final edit can submit immediately without waiting for debounced validation', async ({ page }) => {
  const { initialTaskCount, editor, phaseInput, saveButton } = await openRootEditor(page);

  await expect(saveButton).toHaveJSProperty('disabled', false);
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).toHaveAttribute('aria-describedby', 'editor-errors');

  await phaseInput.fill('P9000.즉시 저장 검증');
  await saveButton.evaluate((button) => button.click());

  await expect(editor).toHaveCount(0);
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount + 1);
});

test('Enter after the final required edit submits against the latest draft', async ({ page }) => {
  const { initialTaskCount, editor, phaseInput } = await openRootEditor(page);

  await phaseInput.fill('P9001.키보드 즉시 저장');
  await phaseInput.press('Enter');

  await expect(editor).toHaveCount(0);
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount + 1);
});

test('invalid immediate activation stays focusable, refreshes errors, and persists nothing', async ({ page }) => {
  const { initialTaskCount, editor, phaseInput, saveButton } = await openRootEditor(page);

  await phaseInput.fill('P9002.유효 상태');
  await expect(saveButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).not.toHaveAttribute('aria-describedby', 'editor-errors');

  await phaseInput.fill('');
  await saveButton.evaluate((button) => {
    button.focus();
    button.click();
  });

  await expect(editor).toBeVisible();
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount);
  await expect(saveButton).toHaveJSProperty('disabled', false);
  await expect(saveButton).toBeFocused();
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).toHaveAttribute('aria-describedby', 'editor-errors');
  await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
});
