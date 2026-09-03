import { test, expect } from '@playwright/test';

test.use({
  viewport: { width: 375, height: 812 },
  isMobile: true,
  hasTouch: true,
});

test('mobile layout renders without breaking and aria-disabled save remains focusable and explains why activation is blocked', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '최상위 작업 추가' }).click();

  const saveButton = page.getByRole('button', { name: '저장', exact: true });
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
  await saveButton.focus();
  await expect(saveButton).toBeFocused();

  await saveButton.click({ force: true });

  await expect(page.locator('.editor-panel')).toBeVisible();
  await expect(page.locator('#toast')).toHaveText('입력값을 올바르게 수정해야 저장할 수 있습니다.');
  await expect(page.locator('#toast')).toHaveAttribute('role', 'status');
  await expect(page.locator('#toast')).toHaveClass(/\bshow\b/);
});
