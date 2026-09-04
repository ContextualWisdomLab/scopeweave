import { test, expect } from '@playwright/test';

test('advertised Escape shortcut closes cloud login and restores its opener', async ({ page }) => {
  await page.goto('./');

  const openLogin = page.getByRole('button', { name: '☁ 클라우드 로그인' });
  await expect(openLogin).toBeVisible();
  await openLogin.click();

  const dialog = page.getByRole('dialog', { name: '클라우드 로그인' });
  const close = dialog.getByRole('button', { name: '닫기' });

  await expect(dialog).toBeVisible();
  await expect(close).toHaveAttribute('aria-keyshortcuts', 'Escape');
  await expect(page.locator('#cloud-email')).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(dialog).toBeHidden();
  await expect(openLogin).toBeFocused();

  await openLogin.click();
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(openLogin).toBeFocused();
});

test('dynamic cloud dialog gets internal focus and one Escape dismissal', async ({ page }) => {
  await page.goto('./');

  await page.evaluate(() => {
    const opener = document.createElement('button');
    opener.id = 'dynamic-share-opener';
    opener.type = 'button';
    opener.textContent = '공유 테스트 열기';

    const dialog = document.createElement('div');
    dialog.id = 'share-modal';
    dialog.className = 'modal hidden';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '동적 공유 테스트');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close-button';
    close.setAttribute('aria-label', '공유 닫기');
    close.setAttribute('aria-keyshortcuts', 'Escape');
    close.textContent = '닫기';
    close.addEventListener('click', () => dialog.classList.add('hidden'));
    dialog.appendChild(close);

    opener.addEventListener('click', () => dialog.classList.remove('hidden'));
    document.body.append(opener, dialog);
  });

  const opener = page.getByRole('button', { name: '공유 테스트 열기' });
  const dialog = page.getByRole('dialog', { name: '동적 공유 테스트' });
  const close = dialog.getByRole('button', { name: '공유 닫기' });

  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
