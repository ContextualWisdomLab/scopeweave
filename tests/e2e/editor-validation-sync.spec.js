import { test, expect } from '@playwright/test';

async function openRootEditor(page) {
  await page.getByRole('button', { name: '최상위 작업 추가' }).click();
  return page.locator('.editor-panel');
}

async function makeSavePresentationValid(page, saveButton) {
  const phaseInput = page.getByTestId('editor-phase');
  await phaseInput.fill('temporarily valid');
  await expect(saveButton).not.toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).not.toHaveAttribute('aria-describedby', 'editor-errors');
  return phaseInput;
}

async function expectInvalidSaveRejected(page, editor, saveButton, initialTaskCount) {
  await expect(saveButton).toBeFocused();
  await expect(editor).toBeVisible();
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).toHaveAttribute('aria-describedby', 'editor-errors');
  await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount);
}

test('invalid pointer save refreshes validation and preserves save focus', async ({ page }) => {
  await page.goto('./');
  const initialTaskCount = await page.locator('tbody tr[data-task-id]').count();
  const editor = await openRootEditor(page);
  const saveButton = editor.getByRole('button', { name: '저장', exact: true });
  const phaseInput = await makeSavePresentationValid(page, saveButton);

  await phaseInput.fill('');
  await saveButton.focus();
  await expect(saveButton).toBeFocused();
  await saveButton.click();

  await expectInvalidSaveRejected(page, editor, saveButton, initialTaskCount);
});

test('invalid keyboard save refreshes validation and preserves save focus', async ({ page }) => {
  await page.goto('./');
  const initialTaskCount = await page.locator('tbody tr[data-task-id]').count();
  const editor = await openRootEditor(page);
  const saveButton = editor.getByRole('button', { name: '저장', exact: true });
  const phaseInput = await makeSavePresentationValid(page, saveButton);

  await phaseInput.fill('');
  await saveButton.focus();
  await expect(saveButton).toBeFocused();
  await saveButton.press('Enter');

  await expectInvalidSaveRejected(page, editor, saveButton, initialTaskCount);
});

test('latest valid draft saves immediately by click and Enter', async ({ page }) => {
  await page.goto('./');
  const initialTaskCount = await page.locator('tbody tr[data-task-id]').count();

  let editor = await openRootEditor(page);
  let phaseInput = page.getByTestId('editor-phase');
  let saveButton = editor.getByRole('button', { name: '저장', exact: true });
  await phaseInput.fill('P9000.즉시 클릭');
  await saveButton.click();

  await expect(editor).toHaveCount(0);
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount + 1);

  editor = await openRootEditor(page);
  phaseInput = page.getByTestId('editor-phase');
  await phaseInput.fill('P9001.즉시 엔터');
  await phaseInput.press('Enter');

  await expect(editor).toHaveCount(0);
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(initialTaskCount + 2);
});

test('latest invalid draft cannot save before debounce completes', async ({ page }) => {
  await page.goto('./');
  const initialTaskCount = await page.locator('tbody tr[data-task-id]').count();
  const editor = await openRootEditor(page);
  const saveButton = editor.getByRole('button', { name: '저장', exact: true });
  const phaseInput = await makeSavePresentationValid(page, saveButton);

  await phaseInput.fill('');
  await saveButton.focus();
  await saveButton.click();

  await expectInvalidSaveRejected(page, editor, saveButton, initialTaskCount);
});
