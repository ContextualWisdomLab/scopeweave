import { test, expect } from '@playwright/test';

test.use({
  viewport: { width: 375, height: 667 },
  isMobile: true,
  hasTouch: true,
});

test('Mobile UI test for aria-disabled on save button', async ({ page }) => {
  await page.goto('/');
  await page.click('#add-root-task');

  // Enter invalid data to trigger validation
  const phaseInput = page.locator('input[data-editor-field="phase"]');
  await phaseInput.fill(''); // Clear it to trigger validation
  await page.keyboard.press('Tab'); // Trigger blur or input events

  const saveButton = page.locator('form[data-editor-form="true"] button[type="submit"]');
  await expect(saveButton).toHaveAttribute('aria-disabled', 'true');

  // Ensure it does NOT use native disabled (Playwright's toBeDisabled checks aria-disabled too)
  const isNativeDisabled = await saveButton.evaluate((btn) => btn.disabled);
  expect(isNativeDisabled).toBe(false);

  await saveButton.click({ force: true });
  await expect(page.locator('#toast')).toContainText('입력값을 올바르게 수정해야 저장할 수 있습니다.');
});
