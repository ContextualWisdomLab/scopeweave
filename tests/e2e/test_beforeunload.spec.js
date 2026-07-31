import { test, expect } from '@playwright/test';

test.describe('ScopeWeave Planner - Palette UX Enhancements (beforeunload)', () => {
  test('shows beforeunload warning when trying to leave page with unsaved editor changes', async ({ page }) => {
    await page.goto('./');

    // Open the editor
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();

    // Verify the editor is open
    await expect(page.locator('.editor-panel')).toBeVisible();

    // Make a change in the editor
    const phaseInput = page.getByTestId('editor-phase');
    await phaseInput.fill('Phase Y');

    // Trigger a page reload. We must handle the dialog.
    let dialogTriggered = false;
    page.on('dialog', async dialog => {
      expect(dialog.type()).toBe('beforeunload');
      dialogTriggered = true;
      await dialog.dismiss(); // Stay on the page
    });

    try {
      await page.reload({ timeout: 1000 });
    } catch (e) {
      // Reload is expected to be intercepted or time out because we dismissed the dialog,
      // but in some playwright versions dismiss() lets the reload happen or fail.
    }

    // Playwright natively dismisses beforeunload if not accepted,
    // but registering the listener captures the event.
    expect(dialogTriggered).toBe(true);
  });
});
