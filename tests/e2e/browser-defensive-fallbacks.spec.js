import { test, expect } from './coverage-test.js';

test.describe('browser defensive fallback contracts', () => {
  test('keeps defensive planner helpers deterministic under malformed or absent state', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => ({
      zeroDurationProgress: window.calculatePlannedProgressRatio(
        '2026-08-20',
        '2026-08-19',
        '2026-08-21',
        0,
      ),
      missingDescendant: window.getLastDescendantId('missing-task-id'),
      invalidPlannedEnd: window.getPlannedEndDateValue(null),
      noHandleWrite: await window.writeJsonSyncFile(null),
      escapedHtml: window.escapeHtml('<owner & "reviewer">'),
      kebabFallback: window.toKebab('custom_FieldID'),
    }));

    expect(result).toEqual({
      zeroDurationProgress: 1,
      missingDescendant: 'missing-task-id',
      invalidPlannedEnd: '',
      noHandleWrite: undefined,
      escapedHtml: '&lt;owner &amp; &quot;reviewer&quot;&gt;',
      kebabFallback: 'custom-field-id',
    });
  });

  test('uses field identity safely when an editor extension has no Korean label mapping', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();
    await expect(page.locator('form[data-editor-form="true"]')).toHaveCount(1);

    const fallback = await page.evaluate(() => {
      const form = document.querySelector('form[data-editor-form="true"]');
      const extensionInput = document.createElement('input');
      extensionInput.dataset.editorField = 'extensionField';
      form.appendChild(extensionInput);
      window.renderEditorValidation();

      window.eval('EDITABLE_FIELDS.push("extensionField")');
      try {
        const errors = window.validateDraft({
          phase: 'Phase',
          activity: 'Activity',
          task: 'Task',
          extensionField: '<unsafe>',
        }, 3);
        return {
          inputMarkedInvalid: extensionInput.getAttribute('aria-invalid'),
          extensionError: errors.find((error) => error.includes('extensionField')) ?? null,
        };
      } finally {
        window.eval('EDITABLE_FIELDS.pop()');
        extensionInput.remove();
      }
    });

    expect(fallback.inputMarkedInvalid).toBeNull();
    expect(fallback.extensionError).toContain('HTML 태그 문자를 사용할 수 없습니다');
  });
});
