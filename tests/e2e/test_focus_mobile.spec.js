import { test, expect } from '@playwright/test';

test.use({
  viewport: { width: 375, height: 667 },
  hasTouch: true,
  isMobile: true
});

test.describe('Focus Restoration on Mobile', () => {
  test('restores focus on mobile view', async ({ page }) => {
    await page.goto('/');

    const addBtn = page.locator('#add-root-task');
    await addBtn.focus();
    await addBtn.click();

    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();
    await page.locator('button[data-action="cancel-editor"]').click();

    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();

    const isFocused = await addBtn.evaluate((node) => document.activeElement === node);
    expect(isFocused).toBeTruthy();
  });
});
