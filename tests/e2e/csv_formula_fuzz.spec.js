import { test, expect } from '@playwright/test';
import fc from 'fast-check';

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
        const dangerous = /^\s*[=+\-@|]/.test(normalized);
        const expectedSanitized = dangerous ? `'${normalized}` : normalized;

        expect(result.sanitized).toBe(expectedSanitized);
        expect(result.escaped.startsWith('"')).toBe(true);
        expect(result.escaped.endsWith('"')).toBe(true);
        expect(result.escaped.slice(1, -1).replace(/""/g, '"')).toBe(expectedSanitized);
        expect(/^\s*[=+\-@|]/.test(result.sanitized)).toBe(false);
      }),
      { numRuns: 100, seed: 20260709 }
    );
  });
});
