import { test, expect } from './coverage-test.js';

test.describe('browser invariant boundaries', () => {
  test('keeps defensive planner helpers deterministic for malformed extension inputs', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => ({
      zeroDurationProgress: window.calculatePlannedProgressRatio(
        new Date('2026-08-20T00:00:00'),
        new Date('2026-08-20T00:00:00'),
        new Date('2026-08-20T00:00:00'),
        0,
      ),
      missingDescendant: window.getLastDescendantId('missing-task-id'),
      malformedEndDate: window.getPlannedEndDateValue(null),
      syncWithoutHandle: await window.writeJsonSyncFile(),
      escapedMarkup: window.escapeHtml(`<script>"'&</script>`),
      extensionTestId: window.toKebab('futureField_name'),
    }));

    expect(result.zeroDurationProgress).toBe(1);
    expect(result.missingDescendant).toBe('missing-task-id');
    expect(result.malformedEndDate).toBe('');
    expect(result.syncWithoutHandle).toBeUndefined();
    expect(result.escapedMarkup).toBe('&lt;script&gt;&quot;&#39;&amp;&lt;/script&gt;');
    expect(result.extensionTestId).toBe('future-field-name');
  });
});
