import { test, expect } from '@playwright/test';

const STORAGE_KEY = 'scopeweave:planner-state:v1';

test.describe('Focus Restoration after Editor Close', () => {
  test('restores focus to add root task button when closing root creator', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#add-root-task');

    // Set initial focus to the button
    const addBtn = page.locator('#add-root-task');
    await addBtn.focus();
    await addBtn.click();

    // Wait for editor to appear
    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();

    // Click cancel
    await page.locator('button[data-action="cancel-editor"]').click();

    // Wait for editor to disappear
    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();

    // Wait for retryable focus restoration
    await expect(addBtn).toBeFocused();
  });

  test('restores focus to edit button when closing task editor', async ({ page }) => {
    await page.goto('/');

    // Add a root task first
    await page.click('#add-root-task');
    await page.waitForSelector('form[data-editor-form="true"]');
    await page.fill('input[data-editor-field="phase"]', 'My Phase');
    await page.click('button[type="submit"]');

    // Locate the edit button for the newly created task (first row)
    const firstRow = page.locator('tr.task-row').first();
    const editBtn = firstRow.locator('button[data-action="edit"]');

    await editBtn.focus();
    await editBtn.click();

    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();

    // Cancel editing
    await page.locator('button[data-action="cancel-editor"]').click();
    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();

    // Wait for retryable focus restoration on the edit button
    await expect(editBtn).toBeFocused();
  });

  test('restores focus when a persisted task id contains CSS selector syntax', async ({ page }) => {
    await page.goto('/');

    // Persist a real task first so this exercises the production storage/load path.
    await page.click('#add-root-task');
    await page.waitForSelector('form[data-editor-form="true"]');
    await page.fill('input[data-editor-field="phase"]', 'Selector-safe focus');
    await page.click('button[type="submit"]');

    const selectorHostileId = 'task"] [data-action="delete';
    await page.evaluate(({ storageKey, taskId }) => {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!saved?.tasks?.length) throw new Error('expected persisted task state');
      saved.tasks[0].id = taskId;
      localStorage.setItem(storageKey, JSON.stringify(saved));
    }, { storageKey: STORAGE_KEY, taskId: selectorHostileId });
    await page.reload();

    const firstRow = page.locator('tr.task-row').first();
    const editBtn = firstRow.locator('button[data-action="edit"]');
    await editBtn.focus();
    await editBtn.click();
    await expect(page.locator('form[data-editor-form="true"]')).toBeVisible();

    await page.locator('button[data-action="cancel-editor"]').click();
    await expect(page.locator('form[data-editor-form="true"]')).not.toBeVisible();
    await expect(editBtn).toBeFocused();
  });
});
