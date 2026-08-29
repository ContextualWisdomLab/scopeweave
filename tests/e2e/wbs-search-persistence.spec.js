import { test, expect } from './coverage-fixtures.js';

const STORAGE_KEY = 'scopeweave:planner-state:v1';

test('keeps WBS search ephemeral across persistence and reload', async ({ page }) => {
  await page.goto('./');

  const search = page.getByRole('searchbox', { name: 'WBS 작업 검색' });
  const rows = page.locator('tbody tr[data-task-id]');

  await expect(rows).toHaveCount(4);
  await page.getByTestId('project-name-input').fill('Search persistence');
  await expect.poll(async () => page.evaluate((storageKey) => localStorage.getItem(storageKey), STORAGE_KEY)).not.toBeNull();

  await search.fill('단계작업계획');
  await expect(rows).toHaveCount(3);

  const persistedState = await page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  }, STORAGE_KEY);

  expect(persistedState).not.toBeNull();
  expect(persistedState).not.toHaveProperty('taskQuery');

  await page.reload();

  await expect(page.getByRole('searchbox', { name: 'WBS 작업 검색' })).toHaveValue('');
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
});
