import { test, expect } from '@playwright/test';

test.describe('ScopeWeave Planner - Editor UX Enhancements', () => {
  test('save button uses aria-disabled and prevents submission when invalid', async ({ page }) => {
    // Intercept API calls to prevent actual saving if it tries
    await page.route('/api/wbs', route => route.abort());

    await page.goto('/');

    // Add a new row to open the editor
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();

    // Verify the editor is open
    const editorPanel = page.locator('.editor-panel').first();
    await expect(editorPanel).toBeVisible();

    // Find the save button inside the editor
    const saveButton = editorPanel.locator('button[type="submit"]');
    await expect(saveButton).toBeVisible();

    // Check that aria-disabled is applied initially since required fields are empty
    await expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    await expect(saveButton).not.toHaveAttribute('disabled');

    // Click the button using page.evaluate so it triggers the form submission event
    await page.evaluate(() => {
        document.querySelector('.editor-panel form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    });

    // Verify that a toast message appears explaining why it can't be saved
    const toast = page.locator('#toast');
    await expect(toast).toHaveClass(/show/);
    await expect(toast).toContainText('입력값을 올바르게 수정해야 저장할 수 있습니다.');

    // Now make the form valid again
    const phaseInput = editorPanel.locator('input[id^="editor-input-phase-"]');
    await phaseInput.fill('P0000.ValidPhase');
    await page.evaluate(() => {
        document.querySelector('input[id^="editor-input-phase-"]').dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    // Verify aria-disabled is removed
    await expect(saveButton).not.toHaveAttribute('aria-disabled', 'true');
  });
});
