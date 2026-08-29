import { test, expect } from './coverage-test.js';

test('creates and persists a task when randomUUID is unavailable but getRandomValues exists', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
  });
  await page.route('**/wbs.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: '[]',
  }));
  await page.goto('/');

  await page.getByRole('button', { name: '최상위 작업 추가' }).first().click();
  await page.getByTestId('editor-phase').fill('Secure fallback task');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  const row = page.locator('tbody tr[data-task-id]').filter({ hasText: 'Secure fallback task' });
  await expect(row).toHaveCount(1);
  const taskId = await row.getAttribute('data-task-id');
  expect(taskId).toMatch(/^task-[0-9a-f]+-[0-9a-f]+$/);

  await page.reload();
  const persisted = page.locator(`tbody tr[data-task-id="${taskId}"]`);
  await expect(persisted).toContainText('Secure fallback task');
});

test('refuses to create a task when the browser exposes no secure random source', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperties(window.crypto, {
      randomUUID: { configurable: true, value: undefined },
      getRandomValues: { configurable: true, value: undefined },
    });
  });
  await page.route('**/wbs.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: '[]',
  }));
  await page.goto('/');

  await page.getByRole('button', { name: '최상위 작업 추가' }).first().click();
  await page.getByTestId('editor-phase').fill('Must not receive an insecure id');

  const pageError = page.waitForEvent('pageerror');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(pageError).resolves.toMatchObject({
    message: 'Secure random number generation is not supported in this environment',
  });

  await expect(page.locator('tbody tr[data-task-id]').filter({ hasText: 'Must not receive an insecure id' })).toHaveCount(0);
  await expect(page.getByTestId('editor-phase')).toHaveValue('Must not receive an insecure id');
});
