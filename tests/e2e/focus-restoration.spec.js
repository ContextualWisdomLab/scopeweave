import { test, expect } from '@playwright/test';

test('Focus should be restored to the same action button after editor closes', async ({ page }) => {
  await page.goto('/');
  await page.click('#add-root-task');

  // Fill the Phase input to make the save button enabled
  await page.fill('input[data-editor-field="phase"]', 'Phase 1');
  await page.click('button[type="submit"]');

  // Find edit button
  const editButton = page.locator('button[data-action="edit"]').first();
  await editButton.click();

  // Close editor via Cancel button
  await page.click('button[data-action="cancel-editor"]');

  // Verify focus is back on the edit button
  const editedButton = page.locator('button[data-action="edit"]').first();
  await expect(editedButton).toBeFocused();
});
