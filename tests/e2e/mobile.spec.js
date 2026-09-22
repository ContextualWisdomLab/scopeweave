import { test, expect } from '@playwright/test';

test.use({
  viewport: { width: 375, height: 667 },
  isMobile: true,
  hasTouch: true,
});

test('Mobile UI renders correctly', async ({ page }) => {
  await page.goto('http://localhost:4173/');
  const title = await page.title();
  expect(title).toBe('ScopeWeave');
});
