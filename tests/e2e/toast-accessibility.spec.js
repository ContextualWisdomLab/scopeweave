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

  await expect.poll(
    () => toast.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
    { message: 'toast opacity should reach its fully visible transition state' },
  ).toBeGreaterThanOrEqual(0.99);

  await expect.poll(
    () => toast.evaluate((element) => document.activeElement === element),
    { message: 'advisory status must not capture keyboard focus' },
  ).toBe(false);
});

test('summary cards expose keyboard-focusable descriptions without relying on title alone', async ({ page }) => {
  await page.goto('/');

  const cases = [
    {
      card: page.locator('.meta-value-card').first(),
      descriptionId: 'summary-total-days-description',
      description: '프로젝트의 작업 기간(일수) 합계입니다.',
    },
    {
      card: page.locator('.plan-card'),
      descriptionId: 'summary-planned-progress-description',
      description: '기간(일수) 가중치가 반영된 프로젝트 전체 계획 진척률입니다.',
    },
    {
      card: page.locator('.actual-card'),
      descriptionId: 'summary-actual-progress-description',
      description: '기간(일수) 가중치가 반영된 프로젝트 전체 실적 진척률입니다.',
    },
  ];

  for (const { card, descriptionId, description } of cases) {
    await expect(card).toHaveAttribute('aria-describedby', descriptionId);
    const descriptionNode = page.locator(`#${descriptionId}`);
    await expect(descriptionNode).toHaveText(description);
    await expect(descriptionNode).toBeHidden();

    await card.focus();
    await expect(card).toBeFocused();
    await expect(descriptionNode).toBeVisible();
  }
});
