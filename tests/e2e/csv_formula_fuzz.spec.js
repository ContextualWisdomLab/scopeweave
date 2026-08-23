import { test, expect } from '@playwright/test';
import fc from 'fast-check';

const DANGEROUS_CSV_PREFIX_PATTERN = /^\s*[=+\-@|＝＋－＠｜]/;

test.describe('CSV formula fuzzing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
  });

  test('neutralizes spreadsheet formula prefixes before CSV escaping', async ({ page }) => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 128 }), async (candidate) => {
        const result = await page.evaluate((value) => ({
          escaped: window.csvEscape(value),
          sanitized: window.sanitizeCsvFormulaValue(value)
        }), candidate);
        const normalized = String(candidate ?? '');
        const dangerous = DANGEROUS_CSV_PREFIX_PATTERN.test(normalized);
        const expectedSanitized = dangerous ? `'${normalized}` : normalized;

        expect(result.sanitized).toBe(expectedSanitized);
        expect(result.escaped.startsWith('"')).toBe(true);
        expect(result.escaped.endsWith('"')).toBe(true);
        expect(result.escaped.slice(1, -1).replace(/""/g, '"')).toBe(expectedSanitized);
        expect(DANGEROUS_CSV_PREFIX_PATTERN.test(result.sanitized)).toBe(false);
      }),
      { numRuns: 100, seed: 20260709 }
    );
  });

  test('neutralizes fullwidth formula-prefix compatibility characters', async ({ page }) => {
    const compatibilityPrefixes = ['＝', '＋', '－', '＠', '｜'];

    for (const prefix of compatibilityPrefixes) {
      for (const candidate of [`${prefix}1+1`, ` \t${prefix}SUM(A1:A2)`]) {
        const result = await page.evaluate((value) => ({
          escaped: window.csvEscape(value),
          sanitized: window.sanitizeCsvFormulaValue(value)
        }), candidate);
        const expectedSanitized = `'${candidate}`;

        expect(result.sanitized).toBe(expectedSanitized);
        expect(result.escaped.startsWith('"')).toBe(true);
        expect(result.escaped.endsWith('"')).toBe(true);
        expect(result.escaped.slice(1, -1).replace(/""/g, '"')).toBe(expectedSanitized);
      }
    }
  });
});