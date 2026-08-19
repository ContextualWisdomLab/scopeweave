import { test, expect } from './coverage-test.js';

test.describe('browser residual production behavior', () => {
  test('fails safe when direct JSON file sync is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      // Chromium does not normally expose this API, but keep the regression
      // deterministic if a future browser/runtime starts doing so.
      try { delete window.showSaveFilePicker; } catch { window.showSaveFilePicker = undefined; }
    });
    await page.goto('/');

    const connect = page.getByRole('button', { name: /wbs\.json/ });
    await expect(connect).toHaveAttribute('aria-disabled', 'true');
    await connect.click();
    await expect(page.locator('#toast')).toContainText('지원하지 않습니다');
  });

  test('normalizes tampered explicit seed depths through the shipped three-level contract', async ({ page }) => {
    await page.route('**/wbs.json', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        { __id: 'phase-invalid-depth', __depth: '9', phase: 'Tampered Phase' },
        { __id: 'activity-invalid-depth', __depth: '0', activity: 'Tampered Activity' },
        { __id: 'task-invalid-depth', __depth: 'not-a-number', task: 'Tampered Task' },
        { __id: 'valid-explicit-depth', __depth: '2', activity: 'Explicit Activity' },
      ]),
    }));
    await page.goto('/');

    await expect(page.locator('tr[data-task-id="phase-invalid-depth"]')).toHaveClass(/depth-1/);
    await expect(page.locator('tr[data-task-id="activity-invalid-depth"]')).toHaveClass(/depth-2/);
    await expect(page.locator('tr[data-task-id="task-invalid-depth"]')).toHaveClass(/depth-3/);
    await expect(page.locator('tr[data-task-id="valid-explicit-depth"]')).toHaveClass(/depth-2/);
  });

  test('renders warning badges through the public browser test seam', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(() => {
      const emptyWarning = window.createTextCellContent('', '필수값 경고');
      const textWarning = window.createTextCellContent('값', '범위 경고');
      return {
        emptyWarning: emptyWarning.textContent,
        textWarning: textWarning.textContent,
        nullValidation: window.validateDraft(null, 1),
      };
    });

    expect(result.emptyWarning).toBe('필수값 경고');
    expect(result.textWarning).toContain('값');
    expect(result.textWarning).toContain('범위 경고');
    expect(result.nullValidation).toEqual([]);
  });

  test('returns focus when the Gantt dialog closes and isolates persistence failures', async ({ page }) => {
    await page.route('**/wbs.json', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ __id: 'gantt-task', __depth: 1, phase: 'Gantt Phase' }]),
    }));
    await page.goto('/');

    const openGantt = page.getByRole('button', { name: '간트차트보기' });
    await openGantt.click();
    await expect(page.locator('#gantt-modal')).not.toHaveClass(/hidden/);
    await page.getByRole('button', { name: '간트 차트 닫기' }).click();
    await expect(page.locator('#gantt-modal')).toHaveClass(/hidden/);
    await expect(openGantt).toBeFocused();

    await page.evaluate(() => {
      window.__scopeweaveOriginalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw new Error('forced quota'); };
    });
    try {
      const projectName = page.getByTestId('project-name-input');
      await projectName.fill('Persistence failure regression');
      await projectName.blur();
      await expect(page.locator('#toast')).toContainText('저장하지 못했습니다');
    } finally {
      await page.evaluate(() => {
        Storage.prototype.setItem = window.__scopeweaveOriginalSetItem;
        delete window.__scopeweaveOriginalSetItem;
      });
    }
  });
});
