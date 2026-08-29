import { test, expect } from './coverage-fixtures.js';

const STORAGE_KEY = 'scopeweave:planner-state:v1';

function luminance([red, green, blue]) {
  const channels = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function parseRgb(value) {
  const match = value.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

test('captures core planner states with WCAG 2.2 baseline evidence', async ({ page }, testInfo) => {
  await page.goto('./');

  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(4);
  await expect(page.locator('.seed-onboarding')).toBeVisible();
  await expect(page.locator('main#main-content')).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('a.skip-link')).toHaveAttribute('href', '#main-content');
  await expect(page.getByRole('searchbox', { name: 'WBS 작업 검색' }))
    .toHaveAttribute('aria-controls', 'task-table-body');
  await expect(page.locator('th[scope="col"]')).toHaveCount(21);

  const contrast = await page.locator('body').evaluate((element) => ({
    foreground: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor,
  }));
  const foreground = parseRgb(contrast.foreground);
  const background = parseRgb(contrast.background);
  expect(foreground, `expected body foreground color, got ${contrast.foreground}`).not.toBeNull();
  expect(background, `expected body background color, got ${contrast.background}`).not.toBeNull();
  expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);

  const samplePath = testInfo.outputPath('scopeweave-sample.png');
  await page.screenshot({ path: samplePath, fullPage: true });
  await testInfo.attach('scopeweave-sample', { path: samplePath, contentType: 'image/png' });

  await page.keyboard.press('Tab');
  await expect(page.locator('a.skip-link')).toBeFocused();
  const focusPath = testInfo.outputPath('scopeweave-skip-link-focus.png');
  await page.screenshot({ path: focusPath, fullPage: true });
  await testInfo.attach('scopeweave-skip-link-focus', { path: focusPath, contentType: 'image/png' });

  await page.evaluate((storageKey) => {
    localStorage.setItem(storageKey, JSON.stringify({
      projectName: 'Empty visual evidence',
      baseDate: '2026-08-29',
      tasks: [],
    }));
  }, STORAGE_KEY);
  await page.reload();
  await expect(page.locator('.empty-state-cell')).toBeVisible();
  await expect(page.locator('.empty-state-cell').getByRole('button', { name: '최상위 작업 추가' })).toBeVisible();

  const emptyPath = testInfo.outputPath('scopeweave-empty.png');
  await page.screenshot({ path: emptyPath, fullPage: true });
  await testInfo.attach('scopeweave-empty', { path: emptyPath, contentType: 'image/png' });
});
