import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 } });

test('invalid save feedback remains usable at a narrow mobile viewport', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '최상위 작업 추가' }).click();

  const phaseInput = page.locator('[data-testid="editor-phase"]');
  const saveButton = page.getByRole('button', { name: '저장', exact: true });

  await phaseInput.fill('');
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
  expect(await saveButton.evaluate(node => node.disabled)).toBe(false);
  await expect(page.locator('.editor-panel')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await saveButton.focus();
  await expect(saveButton).toBeFocused();
  await saveButton.click();

  await expect(page.locator('#toast')).toContainText('입력값을 올바르게 수정해야 저장할 수 있습니다.');
  await expect(page.locator('#editor-errors')).toContainText('최상위 작업은 단계 값을 입력해야 합니다.');
  await expect(page.locator('.editor-panel')).toBeVisible();
  await expect(phaseInput).toHaveAttribute('aria-invalid', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
