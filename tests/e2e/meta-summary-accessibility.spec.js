import { test, expect } from '@playwright/test';

const summaryExplanations = [
  ['summary-total-days-help', '프로젝트의 작업 기간(일수) 합계입니다.'],
  ['summary-planned-progress-help', '기간(일수) 가중치가 반영된 프로젝트 전체 계획 진척률입니다.'],
  ['summary-actual-progress-help', '기간(일수) 가중치가 반영된 프로젝트 전체 실적 진척률입니다.']
];

test.describe('summary metric explanations', () => {
  test('keeps explanations visible without adding static cards to the Tab order', async ({ page }) => {
    await page.goto('./');

    const cards = page.locator('.meta-value-card');
    await expect(cards).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await expect(cards.nth(index)).not.toHaveAttribute('tabindex');
      await expect(cards.nth(index)).not.toHaveAttribute('role', 'note');
    }

    for (const [id, text] of summaryExplanations) {
      const explanation = page.locator(`#${id}`);
      await expect(explanation).toBeVisible();
      await expect(explanation).toHaveText(text);
    }
  });

  test('keeps the visible explanations inside the mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('./');

    for (const [id] of summaryExplanations) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
