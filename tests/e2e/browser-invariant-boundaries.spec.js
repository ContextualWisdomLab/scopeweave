import { readFileSync } from 'node:fs';
import { test, expect } from './coverage-test.js';

const APP_SOURCE = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
const APP_BOOTSTRAP_LINE = APP_SOURCE
  .split(/\r?\n/)
  .findIndex((line) => line.trim() === 'bootstrap();');

if (APP_BOOTSTRAP_LINE < 0) {
  throw new Error('app.js bootstrap call was not found');
}

test.describe('browser invariant boundaries', () => {
  test('validates a prospective editor registration through the real input path', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    let breakpointId;

    try {
      await cdp.send('Debugger.enable');
      const breakpoint = await cdp.send('Debugger.setBreakpointByUrl', {
        urlRegex: '/app\\.js$',
        lineNumber: APP_BOOTSTRAP_LINE,
        condition: String.raw`(() => {
          EDITABLE_FIELDS.push('futureField');
          const probe = {
            zeroDurationProgress: calculatePlannedProgressRatio(
              '2026-08-20',
              '2026-08-19',
              '2026-08-21',
              0,
            ),
            missingDescendant: getLastDescendantId('missing-task-id'),
            malformedEndDate: getPlannedEndDateValue(null),
            escapedMarkup: escapeHtml('<script>"\'&</script>'),
            extensionTestId: toKebab('futureField_name'),
            noHandleWrite: 'pending',
          };
          globalThis.__scopeweaveInvariantProbe = probe;
          Promise.resolve(writeJsonSyncFile()).then(
            () => { probe.noHandleWrite = 'resolved'; },
            () => { probe.noHandleWrite = 'rejected'; },
          );
          return false;
        })()`,
      });
      breakpointId = breakpoint.breakpointId;

      await page.goto('/');
      await expect.poll(() => page.evaluate(
        () => globalThis.__scopeweaveInvariantProbe?.noHandleWrite ?? null,
      )).toBe('resolved');

      await page.getByRole('button', { name: '최상위 작업 추가' }).click();
      await page.evaluate(() => {
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

      const result = await page.evaluate(() => globalThis.__scopeweaveInvariantProbe);
      expect(result).toEqual({
        zeroDurationProgress: 1,
        missingDescendant: 'missing-task-id',
        malformedEndDate: '',
        escapedMarkup: '&lt;script&gt;&quot;&#39;&amp;&lt;/script&gt;',
        extensionTestId: 'future-field-name',
        noHandleWrite: 'resolved',
      });
    } finally {
      if (breakpointId) {
        await cdp.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {});
      }
      await page.evaluate(() => {
        delete globalThis.__scopeweaveInvariantProbe;
      }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  });
});
