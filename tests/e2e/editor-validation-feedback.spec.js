import { test, expect } from '@playwright/test';

test.describe('editor validation feedback', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
  });

  test('routes an invalid required-field submit through product validation feedback', async ({ page }) => {
    const form = page.locator('form[data-editor-form="true"]');
    const toast = page.locator('#toast');

    await expect(form).toBeVisible();
    await form.evaluate((editorForm) => editorForm.requestSubmit());

    await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
    await expect(toast).toHaveClass(/show/);
    await expect(toast).toContainText('입력값을 올바르게 수정해야 저장할 수 있습니다.');
    await expect(form).toBeVisible();
  });

  test('flushes pending validation before an immediate valid submit', async ({ page }) => {
    const phaseInput = page.locator('[data-testid="editor-phase"]');

    await phaseInput.evaluate((input) => {
      input.value = '즉시 제출 단계';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.form.requestSubmit();
    });

    await expect(page.locator('form[data-editor-form="true"]')).toHaveCount(0);
    await expect(
      page.locator('tbody tr[data-task-id]').filter({ hasText: '즉시 제출 단계' }),
    ).toHaveCount(1);
  });
});
