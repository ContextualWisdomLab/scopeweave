import { test, expect } from '@playwright/test';

test('cloud status feedback is visibly rendered as a non-focus-taking live status', async ({ page }) => {
  await page.goto('/?share=ABCDEFGHIJKLMNOP');

  const toast = page.locator('#toast');
  await expect(toast).toHaveText('공유 링크가 만료되었거나 철회되었습니다.');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toHaveAttribute('aria-live', 'polite');
  await expect(toast).toHaveAttribute('aria-atomic', 'true');
  await expect(toast).not.toHaveAttribute('tabindex', /.+/);
  await expect(toast).toHaveClass(/\bvisible\b/);
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCSS('opacity', '1');

  const activeElementIsToast = await toast.evaluate(
    (element) => document.activeElement === element,
  );

  expect(activeElementIsToast).toBe(false);
});
