import { test, expect } from '@playwright/test';

const SUMMARY_CASES = [
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

test('summary metadata exposes descriptions without adding static content to the tab order', async ({ page }) => {
  await page.goto('./');

  for (const { valueTestId, description } of SUMMARY_CASES) {
    const card = page.getByTestId(valueTestId).locator('..');

    await expect(card).not.toHaveAttribute('tabindex');
    await expect(card).not.toHaveAttribute('role', 'note');
    await expect(card).toHaveAccessibleDescription(description);

    const descriptionId = await card.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    await expect(page.locator(`#${descriptionId}`)).toHaveText(description);
  }
});

test('status badges remain static table information instead of becoming extra tab stops', async ({ page }) => {
  await page.goto('./');

  const badges = page.locator('.status-badge');
  await expect(badges.first()).toBeVisible();
  await expect(page.locator('.status-badge[tabindex]')).toHaveCount(0);
  await expect(page.locator('.status-badge[role="note"]')).toHaveCount(0);
});
