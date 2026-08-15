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

function relativeLuminance([red, green, blue]) {
  const channels = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function blendChannel(foreground, background, alpha) {
  return (alpha * foreground) + ((1 - alpha) * background);
}

function blendRgb(foreground, background, alpha) {
  return foreground.map((channel, index) => blendChannel(channel, background[index], alpha));
}

function interpolateRgb(start, end, progress) {
  return start.map((channel, index) => channel + ((end[index] - channel) * progress));
}

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

  for (const valueTestId of ['summary-planned-progress', 'summary-actual-progress']) {
    test(`${valueTestId} explanation keeps WCAG AA text contrast across its gradient`, async ({ page }) => {
      const card = page.getByTestId(valueTestId).locator('..');
      const description = card.locator('.meta-description');
      const styles = await card.evaluate((element) => {
        const descriptionElement = element.querySelector('.meta-description');
        return {
          backgroundImage: getComputedStyle(element).backgroundImage,
          color: getComputedStyle(descriptionElement).color,
        };
      });

      const colorMatch = styles.color.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
      const gradientMatches = [...styles.backgroundImage.matchAll(/rgb\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)\s*\)/gi)];

      expect(colorMatch, `expected an rgb/rgba description color, got ${styles.color}`).not.toBeNull();
      expect(gradientMatches.length, `expected two gradient color stops, got ${styles.backgroundImage}`).toBeGreaterThanOrEqual(2);

      const foreground = colorMatch.slice(1, 4).map(Number);
      const foregroundAlpha = colorMatch[4] === undefined ? 1 : Number(colorMatch[4]);
      const start = gradientMatches[0].slice(1, 4).map(Number);
      const end = gradientMatches.at(-1).slice(1, 4).map(Number);
      let minimumContrast = Number.POSITIVE_INFINITY;

      for (let sample = 0; sample <= 20; sample += 1) {
        const background = interpolateRgb(start, end, sample / 20);
        const renderedForeground = blendRgb(foreground, background, foregroundAlpha);
        minimumContrast = Math.min(minimumContrast, contrastRatio(renderedForeground, background));
      }

      expect(minimumContrast).toBeGreaterThanOrEqual(4.5);
    });
  }
});
