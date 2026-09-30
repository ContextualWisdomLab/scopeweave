import { test, expect } from '@playwright/test';

test('summary metric descriptions are keyboard-visible and exposed to assistive technology', async ({ page }) => {
  await page.goto('/');

  const cards = page.locator('.meta-value-card');
  await expect(cards).toHaveCount(3);

  for (const card of await cards.all()) {
    await expect(card).not.toHaveAttribute('role', 'note');

    const descriptionId = await card.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();

    const description = page.locator(`#${descriptionId}`);
    await expect(description).toContainText(/\S/);
    await expect(description).toHaveCSS('position', 'absolute');
    await expect(description).toHaveCSS('clip-path', 'inset(50%)');
    await expect(description).toHaveCSS('width', '1px');

    await card.focus();
    await expect(description).toHaveCSS('position', 'static');
    await expect(description).toHaveCSS('clip-path', 'none');
    await expect(description).toBeVisible();
  }
});
