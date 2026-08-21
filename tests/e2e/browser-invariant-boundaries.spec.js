import { test, expect } from './coverage-test.js';

test.describe('browser invariant boundaries', () => {
  test('validates a newly registered editor field through the real input path', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '최상위 작업 추가' }).click();

    await page.evaluate(() => {
      // Simulate a future editable-field registration without widening the public
      // browser API. The production editor must keep its label fallback coherent
      // until that field receives a localized CSV label.
      globalThis.eval("EDITABLE_FIELDS.push('futureField')");
      const grid = document.querySelector('form[data-editor-form="true"] .editor-grid');
      if (!grid) {
        throw new Error('editor grid not found');
      }
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.editorField = 'futureField';
      input.setAttribute('aria-label', 'Future field');
      grid.appendChild(input);
    });

    const futureField = page.getByRole('textbox', { name: 'Future field' });
    await futureField.fill('<future-value>');
    await futureField.dispatchEvent('change');

    await expect(page.locator('#editor-errors')).toContainText(
      'futureField 항목에는 HTML 태그 문자를 사용할 수 없습니다.',
    );
    await expect(futureField).toHaveAttribute('aria-invalid', 'true');
    await expect(futureField).toHaveAttribute('aria-describedby', 'editor-errors');
  });
});
