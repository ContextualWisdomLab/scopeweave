import { test, expect } from '@playwright/test';

test.use({
  viewport: { width: 375, height: 667 },
  isMobile: true,
  hasTouch: true,
});

test('Mobile resolution smoke test', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('ScopeWeave Planner');
});
