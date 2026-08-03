import { test, expect } from '@playwright/test';

test('cached render templates create independent owner, status, and progress nodes', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);

  const ownerBadges = page.locator('.owner-badge');
  const ownerCount = await ownerBadges.count();
  expect(ownerCount).toBeGreaterThanOrEqual(2);

  const ownersAreIndependent = await ownerBadges.evaluateAll((nodes) => ({
    distinctNodes: nodes[0] !== nodes[1],
    initialSecondText: nodes[1].textContent,
  }));
  expect(ownersAreIndependent.distinctNodes).toBe(true);

  await ownerBadges.first().evaluate((node) => {
    node.textContent = 'mutation-probe';
  });
  await expect(ownerBadges.nth(1)).toHaveText(ownersAreIndependent.initialSecondText);

  const statusBadges = page.locator('.status-badge');
  const statusCount = await statusBadges.count();
  expect(statusCount).toBeGreaterThanOrEqual(2);
  expect(await statusBadges.evaluateAll((nodes) => nodes[0] !== nodes[1])).toBe(true);

  const progressLabels = page.locator('label[for^="actual-progress-"]');
  const labelCount = await progressLabels.count();
  expect(labelCount).toBeGreaterThanOrEqual(2);

  const labelBindings = await progressLabels.evaluateAll((labels) => labels.map((label) => {
    const select = label.querySelector('select');
    return {
      htmlFor: label.htmlFor,
      selectId: select?.id || '',
      selectCount: label.querySelectorAll('select').length,
    };
  }));

  expect(new Set(labelBindings.map(({ htmlFor }) => htmlFor)).size).toBe(labelBindings.length);
  for (const binding of labelBindings) {
    expect(binding.selectCount).toBe(1);
    expect(binding.selectId).toBe(binding.htmlFor);
  }
});
