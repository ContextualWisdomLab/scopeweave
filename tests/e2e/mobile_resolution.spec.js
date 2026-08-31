import { test, expect } from '@playwright/test';

test.use({
  viewport: { width: 375, height: 667 },
  isMobile: true,
  hasTouch: true,
});

test('Mobile Resolution Testing', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
});
