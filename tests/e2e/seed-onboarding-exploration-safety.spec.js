import { test, expect } from '@playwright/test';

const PLANNER_STORAGE_KEY = 'scopeweave:planner-state:v1';

async function resetToFirstVisitSeed(page) {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

test('exploring the sample hierarchy does not adopt or persist the sample plan', async ({ page }) => {
  await resetToFirstVisitSeed(page);

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

test('hiding the onboarding notice keeps the sample in exploration-only mode', async ({ page }) => {
  await resetToFirstVisitSeed(page);

  const onboarding = page.locator('#seed-onboarding');
  const rows = page.locator('tbody tr[data-task-id]');

  await expect(onboarding).toBeVisible();
  await page.locator('#dismiss-seed-onboarding').click();
  await expect(onboarding).toBeHidden();
  expect(await page.evaluate((key) => localStorage.getItem(key), PLANNER_STORAGE_KEY)).toBeNull();

  await rows.first().locator('button[data-action="toggle"]').click();

  await expect(rows).toHaveCount(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), PLANNER_STORAGE_KEY)).toBeNull();

  await page.reload();

  await expect(onboarding).toBeHidden();
  await expect(rows).toHaveCount(4);
  expect(await page.evaluate((key) => localStorage.getItem(key), PLANNER_STORAGE_KEY)).toBeNull();
});

test('exploring sample progress does not adopt or persist the sample plan', async ({ page }) => {
  await resetToFirstVisitSeed(page);

  const onboarding = page.locator('#seed-onboarding');
  const rows = page.locator('tbody tr[data-task-id]');
  const progress = rows.last().locator('select[data-inline-progress]');

  await expect(onboarding).toBeVisible();
  await expect(rows).toHaveCount(4);
  await expect(progress).toHaveValue('미착수(0%)');

  await progress.selectOption('진행(50%)');

  await expect(progress).toHaveValue('진행(50%)');
  await expect(onboarding).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), PLANNER_STORAGE_KEY)).toBeNull();

  await page.reload();

  await expect(onboarding).toBeVisible();
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
  await expect(page.locator('tbody tr[data-task-id]').last().locator('select[data-inline-progress]')).toHaveValue('미착수(0%)');
});

test('exploring sample order does not adopt or persist the sample plan', async ({ page }) => {
  await resetToFirstVisitSeed(page);

  const onboarding = page.locator('#seed-onboarding');
  const rows = page.locator('tbody tr[data-task-id]');
  await expect(onboarding).toBeVisible();
  await expect(rows).toHaveCount(4);

  const dragged = rows.nth(2);
  const target = rows.nth(3);
  const draggedTask = await dragged.locator('td').nth(3).innerText();
  const targetTask = await target.locator('td').nth(3).innerText();
  expect(draggedTask).not.toBe(targetTask);

  const targetBox = await target.boundingBox();
  await dragged.dragTo(target, {
    targetPosition: { x: 20, y: Math.max(4, Math.round((targetBox?.height || 40) - 4)) }
  });

  await expect(rows.nth(2).locator('td').nth(3)).toHaveText(targetTask);
  await expect(rows.nth(3).locator('td').nth(3)).toHaveText(draggedTask);
  await expect(onboarding).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), PLANNER_STORAGE_KEY)).toBeNull();

  await page.reload();

  await expect(onboarding).toBeVisible();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(2).locator('td').nth(3)).toHaveText(draggedTask);
  await expect(rows.nth(3).locator('td').nth(3)).toHaveText(targetTask);
});