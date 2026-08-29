import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
test('Validation should aria-disable save button instead of native disabled (Mobile)', async ({ page }) => {
  await page.goto('./');

  // Click on "최상위 작업 추가" to open editor
  await page.click('#add-root-task');

  // Verify the form is present
  const form = page.locator('form[data-editor-form="true"]');
  await expect(form).toBeVisible();

  // Find the save button
  const saveButton = form.locator('button[type="submit"]');

  // Since the form is empty, it should be invalid and aria-disabled
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
  await expect(saveButton).not.toHaveAttribute('disabled', '');

  // Submit the form
  await saveButton.click({ force: true });

  // Expect form to still be visible (click should be prevented)
  await expect(form).toBeVisible();

  // Fill in the required field to make it valid
  await page.fill('input[data-editor-field="phase"]', 'Test Phase');

  // Verify it is no longer aria-disabled
  await expect(saveButton).not.toHaveAttribute('aria-disabled', 'true');

  // Submit the form
  await saveButton.click({ force: true });

  // Verify form is closed
  await expect(form).toBeHidden();
});
