import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
test('Clicking disabled save button should show a toast message (Mobile)', async ({ page }) => {
  await page.goto('./');

  // Click on "최상위 작업 추가" to open editor
  await page.click('#add-root-task');

  // Verify the form is present
  const form = page.locator('form[data-editor-form="true"]');
  await expect(form).toBeVisible();

  // Find the save button
  const saveButton = form.locator('button[type="submit"]');

  // Submit the form
  await saveButton.click({ force: true });

  // Expect toast message to appear
  const toast = page.locator('#toast');
  await expect(toast).toContainText('입력값을 올바르게 수정해야 저장할 수 있습니다.');
});
