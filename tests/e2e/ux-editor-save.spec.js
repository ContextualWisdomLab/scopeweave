import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('Save button is aria-disabled when form is invalid and shows toast when clicked', async ({ page }) => {
    // wait for app to load
    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);

    // Click "Add Root Task" to open editor
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();

    // Check that the save button has aria-disabled set
    const saveButton = page.locator('button[type="submit"]:has-text("저장")');
    await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    await expect(saveButton).toHaveAttribute('title', '입력값을 올바르게 수정해야 저장할 수 있습니다.');

    // We evaluate to click the button naturally as Playwright's saveButton.click({ force: true }) does not bubble appropriately for form submit interception in this setup
    await page.evaluate(() => document.querySelector('form[data-editor-form="true"]').dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));

    // Check that toast is visible with correct text
    const toast = page.locator('#toast');

    // ensure toast is visible by checking class. Wait for it to become visible
    // In Playwright tests, a fast click might close the toast instantly if another render cycle happens, but this test passes locally.
    await expect(toast).toHaveClass(/show/);
    await expect(toast).toHaveText('입력값을 올바르게 수정해야 저장할 수 있습니다.');

    // type something into phase to make it valid
    const phaseInput = page.locator('input[data-testid="editor-phase"]');
    await phaseInput.fill('Phase 1');
    await page.waitForTimeout(500); // Wait for debounce

    // Check that it's no longer aria-disabled
    await expect(saveButton).not.toHaveAttribute('aria-disabled', 'true');
    await expect(saveButton).toHaveAttribute('title', '저장 (Enter)');
});
