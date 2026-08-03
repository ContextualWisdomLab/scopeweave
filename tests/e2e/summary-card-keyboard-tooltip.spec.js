import { test, expect } from '@playwright/test';

test('summary-card tooltips are reachable and visibly focused from the keyboard', async ({ page }) => {
  await page.goto('./');

  const cards = page.locator('.meta-value-card[title]');
  await expect(cards).toHaveCount(3);

  for (let index = 0; index < await cards.count(); index += 1) {
    const card = cards.nth(index);
    await expect(card).toHaveAttribute('tabindex', '0');
    await expect(card).toHaveAttribute('title', /\S/);

    await card.focus();
    await expect(card).toBeFocused();

    const focusStyle = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });

    expect(focusStyle.outlineStyle).not.toBe('none');
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThan(0);
  }
});
