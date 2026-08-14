import { test, expect } from '@playwright/test';

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

    // Evaluate active element
    const isFocused = await addBtn.evaluate((node) => document.activeElement === node);
    expect(isFocused).toBeTruthy();
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

    // Check focus on the edit button
    const isFocused = await editBtn.evaluate((node) => document.activeElement === node);
    expect(isFocused).toBeTruthy();
  });
});
