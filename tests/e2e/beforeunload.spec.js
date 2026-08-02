import { test, expect } from '@playwright/test';

test.describe('Inline editor unsaved-change guards', () => {
  test('Escape on dirty editor prompts before discard', async ({ page }) => {
    await page.goto('./');

    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await expect(page.locator('.editor-panel')).toBeVisible();

    await page.locator('[data-testid="editor-phase"]').fill('Phase dirty');

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('저장하지 않은 변경 사항');
      await dialog.dismiss();
    });
    await page.keyboard.press('Escape');

    // Dismiss keeps the editor open with the draft.
    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(page.locator('[data-testid="editor-phase"]')).toHaveValue('Phase dirty');
  });

  test('beforeunload fires when draft is dirty', async ({ page }) => {
    await page.goto('./');

    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await page.locator('[data-testid="editor-phase"]').fill('Phase leave');

    let sawBeforeUnload = false;
    page.on('dialog', async (dialog) => {
      if (dialog.type() === 'beforeunload') {
        sawBeforeUnload = true;
        await dialog.dismiss();
        return;
      }
      await dialog.dismiss();
    });

    // Navigate away; browsers emit beforeunload for dirty handlers.
    await page.evaluate(() => {
      window.location.href = 'about:blank';
    }).catch(() => {
      // Navigation may be aborted when beforeunload is cancelled.
    });

    // Give the dialog a moment to surface in headed/CI chromium.
    await page.waitForTimeout(300);
    expect(sawBeforeUnload).toBe(true);
  });
});
