import { test, expect } from '@playwright/test';

const cards = [
  {
    metric: 'summary-total-days',
    description: '프로젝트의 작업 기간(일수) 합계입니다.',
  },
  {
    metric: 'summary-planned-progress',
    description: '기간(일수) 가중치가 반영된 프로젝트 전체 계획 진척률입니다.',
  },
  {
    metric: 'summary-actual-progress',
    description: '기간(일수) 가중치가 반영된 프로젝트 전체 실적 진척률입니다.',
  },
];

test('summary metric cards expose tooltip help to keyboard and assistive technology', async ({ page }) => {
  await page.goto('./');

  for (const { metric, description } of cards) {
    const card = page.getByTestId(metric).locator('..');
    await expect(card).toHaveAttribute('tabindex', '0');

    const descriptionId = await card.getAttribute('aria-describedby');
    expect(descriptionId, `${metric} must reference an explicit description`).toBeTruthy();
    await expect(page.locator(`#${descriptionId}`)).toHaveText(description);

    await card.focus();
    await expect(card).toBeFocused();
    const outlineStyle = await card.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(outlineStyle).not.toBe('none');
  }
});
