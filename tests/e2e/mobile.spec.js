import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 667 } });

test('mobile resolution test', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/ScopeWeave/);
  // Verify main content is visible on mobile viewport
  const mainContent = page.locator('#main-content');
  await expect(mainContent).toBeVisible();
});
