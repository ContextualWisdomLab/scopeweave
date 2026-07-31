import { test, expect } from '@playwright/test';

test('Focus is restored after closing editor', async ({ page }) => {
  await page.goto('http://localhost:4173');

  // Start with wbs.json which has rows
  // Wait for the table rows to load
  await page.waitForSelector('tr[data-task-id]');

  // Click add root task button
  await page.click('#add-root-task');

  // Check if editor is open
  await page.waitForSelector('form[data-editor-form="true"]');

  // Close editor with cancel button
  await page.click('button[data-action="cancel-editor"]');

  // Wait a bit for requestAnimationFrame
  await page.waitForTimeout(100);

  // Focus should be restored to add root task button
  await expect(page.locator('#add-root-task')).toBeFocused();

  // Click edit button on the first task row
  const firstRow = page.locator('tr[data-task-id]').first();
  const editBtn = firstRow.locator('button[data-action="edit"]');
  await editBtn.focus();
  await editBtn.click();

  // Check if editor is open
  await page.waitForSelector('form[data-editor-form="true"]');

  // Close editor with cancel button
  await page.click('button[data-action="cancel-editor"]');

  // Wait a bit for requestAnimationFrame
  await page.waitForTimeout(100);

  // Focus should be restored to the edit button!
  const newEditBtn = page.locator('tr[data-task-id]').first().locator('button[data-action="edit"]');
  await expect(newEditBtn).toBeFocused();
});
