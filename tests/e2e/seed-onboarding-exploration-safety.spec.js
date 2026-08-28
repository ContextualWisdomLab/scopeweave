import { test, expect } from '@playwright/test';

const PLANNER_STORAGE_KEY = 'scopeweave:planner-state:v1';

test('exploring the sample hierarchy does not adopt or persist the sample plan', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const onboarding = page.locator('#seed-onboarding');
  const rows = page.locator('tbody tr[data-task-id]');
  const firstToggle = rows.first().locator('button[data-action="toggle"]');

  await expect(onboarding).toBeVisible();
  await expect(rows).toHaveCount(4);
  expect(await page.evaluate((key) => localStorage.getItem(key), PLANNER_STORAGE_KEY)).toBeNull();

  await firstToggle.click();

  await expect(rows).toHaveCount(1);
  await expect(onboarding).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), PLANNER_STORAGE_KEY)).toBeNull();

  await page.reload();

  await expect(onboarding).toBeVisible();
  await expect(rows).toHaveCount(4);
});
