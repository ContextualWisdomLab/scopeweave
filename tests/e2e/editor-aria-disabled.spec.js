import { test, expect } from '@playwright/test';

test.describe('inline editor disabled-state feedback', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
  });

  test('routes an invalid required-field submit through application feedback', async ({ page }) => {
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();

    const phaseInput = page.locator('[data-testid="editor-phase"]');
    const saveButton = page.getByRole('button', { name: '저장', exact: true });

    await phaseInput.fill('');
    await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    await expect(saveButton).toBeEnabled();

    await saveButton.focus();
    await expect(saveButton).toBeFocused();
    await saveButton.press('Enter');

    await expect(page.locator('#toast')).toContainText('입력값을 올바르게 수정해야 저장할 수 있습니다.');
    await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(phaseInput).toHaveAttribute('aria-invalid', 'true');
  });
});
