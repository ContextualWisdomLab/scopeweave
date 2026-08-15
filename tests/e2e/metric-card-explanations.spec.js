import { test, expect } from '@playwright/test';

const metricCases = [
  {
    valueTestId: 'summary-total-days',
    description: '프로젝트의 작업 기간(일수) 합계입니다.',
  },
  {
    valueTestId: 'summary-planned-progress',
    description: '기간(일수) 가중치가 반영된 프로젝트 전체 계획 진척률입니다.',
  },
  {
    valueTestId: 'summary-actual-progress',
    description: '기간(일수) 가중치가 반영된 프로젝트 전체 실적 진척률입니다.',
  },
];

test.describe('summary metric explanations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
  });

  for (const { valueTestId, description } of metricCases) {
    test(`keeps ${valueTestId} help visible without a synthetic keyboard stop`, async ({ page }) => {
      const value = page.getByTestId(valueTestId);
      const card = value.locator('..');

      await expect(value).toBeVisible();
      await expect(card.getByText(description, { exact: true })).toBeVisible();
      await expect(card).not.toHaveAttribute('tabindex', '0');
      await expect(card).not.toHaveAttribute('role', 'note');
      await expect(card).not.toHaveAttribute('title', description);
    });
  }
});
