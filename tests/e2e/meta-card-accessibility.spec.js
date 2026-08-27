import { test, expect } from '@playwright/test';

test('summary cards expose keyboard-focusable descriptions without relying on title alone', async ({ page }) => {
  await page.goto('./');

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
