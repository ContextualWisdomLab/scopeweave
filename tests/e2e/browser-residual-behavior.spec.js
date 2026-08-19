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
    await expect(connect).toHaveAttribute('title', /지원하지 않습니다/);
    await connect.focus();
    await page.keyboard.press('Enter');
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

  test('collapses nested work and restores descendant editing without losing hierarchy', async ({ page }) => {
    await page.route('**/wbs.json', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        { __id: 'phase-a', __depth: 1, phase: 'Phase A' },
        { __id: 'activity-a', __parentId: 'phase-a', __depth: 2, phase: 'Phase A', activity: 'Activity A' },
        { __id: 'task-a', __parentId: 'activity-a', __depth: 3, phase: 'Phase A', activity: 'Activity A', task: 'Task A' },
      ]),
    }));
    await page.goto('/');

    const phaseRow = page.locator('tr[data-task-id="phase-a"]');
    const activityRow = page.locator('tr[data-task-id="activity-a"]');
    const taskRow = page.locator('tr[data-task-id="task-a"]');
    await expect(phaseRow).toBeVisible();
    await expect(activityRow).toBeVisible();
    await expect(taskRow).toBeVisible();

    await phaseRow.getByRole('button', { name: /접기/ }).click();
    await expect(activityRow).toHaveCount(0);
    await expect(taskRow).toHaveCount(0);
    await expect(phaseRow.getByRole('button', { name: /펼치기/ })).toHaveAttribute('aria-expanded', 'false');

    await phaseRow.getByRole('button', { name: /펼치기/ }).click();
    await expect(activityRow).toBeVisible();
    await expect(taskRow).toBeVisible();
    await expect(phaseRow.getByRole('button', { name: /접기/ })).toHaveAttribute('aria-expanded', 'true');

    await taskRow.locator('td').nth(3).click();
    await expect(page.locator('.editor-panel')).toBeVisible();
    await expect(page.getByTestId('editor-task')).toHaveValue('Task A');
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await expect(page.locator('.editor-panel')).toHaveCount(0);
    await expect(taskRow).toBeVisible();
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

  test('executes shipped classic-script text normalization helpers against hostile text', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(() => {
      const probe = document.createElement('script');
      probe.textContent = `
        window.__scopeweaveResidualTextSafety = {
          escaped: escapeHtml('<>&' + String.fromCharCode(34, 39)),
          kebab: toKebab('actualProgress_status')
        };
      `;
      document.body.appendChild(probe);
      probe.remove();
      const captured = window.__scopeweaveResidualTextSafety;
      delete window.__scopeweaveResidualTextSafety;
      return captured;
    });

    expect(result.escaped).toBe('&lt;&gt;&amp;&quot;&#39;');
    expect(result.kebab).toBe('actual-progress-status');
  });

  test('keeps empty-plan actions useful and bounded instead of silently doing nothing', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('scopeweave:planner-state:v1', JSON.stringify({
        projectName: 'Empty residual plan',
        baseDate: '2026-08-19',
        tasks: [],
      }));
    });
    await page.goto('/');

    await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(0);
    const exportButton = page.getByRole('button', { name: 'CSV 내보내기' });
    await exportButton.click();
    await expect(page.locator('#toast')).toContainText('내보낼 작업이 없습니다');

    const ganttButton = page.getByRole('button', { name: '간트차트보기' });
    await ganttButton.click();
    await expect(page.locator('#toast')).toContainText('간트 차트로 표시할 작업이 없습니다');

    const emptyState = page.locator('.table-empty');
    await emptyState.getByRole('button', { name: '최상위 작업 추가' }).click();
    await expect(page.locator('.editor-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.editor-panel')).toHaveCount(0);
    await expect(emptyState).toBeVisible();

    const chooserPromise = page.waitForEvent('filechooser');
    await emptyState.getByRole('button', { name: 'CSV 가져오기' }).click();
    const chooser = await chooserPromise;
    expect(chooser.isMultiple()).toBe(false);
  });

  test('normalizes oversized project metadata and an emptied base date through the visible inputs', async ({ page }) => {
    await page.goto('/');
    const longName = 'P'.repeat(121);

    await page.getByTestId('project-name-input').evaluate((input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, longName);
    await expect(page.getByTestId('project-name-input')).toHaveValue('P'.repeat(120));
    await expect(page).toHaveTitle(`${'P'.repeat(120)} - ScopeWeave Planner`);

    const baseDate = page.getByTestId('base-date-input');
    await baseDate.evaluate((input) => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(baseDate).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
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
