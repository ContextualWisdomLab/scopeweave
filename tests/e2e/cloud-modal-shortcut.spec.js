import { test, expect } from '@playwright/test';

test('advertised Escape shortcut closes the cloud login dialog', async ({ page }) => {
  await page.goto('./');

  const openLogin = page.getByRole('button', { name: '☁ 클라우드 로그인' });
  await expect(openLogin).toBeVisible();
  await openLogin.click();

  const dialog = page.getByRole('dialog', { name: '클라우드 로그인' });
  const close = dialog.getByRole('button', { name: '닫기' });

  await expect(dialog).toBeVisible();
  await expect(close).toHaveAttribute('aria-keyshortcuts', 'Escape');

  await page.keyboard.press('Escape');

  await expect(dialog).toBeHidden();
});
