import { test, expect } from './coverage-test.js';

async function runClassicProbe(page, body) {
  const resultKey = `__scopeweaveResidual${Date.now()}${Math.random().toString(16).slice(2)}`;
  await page.addScriptTag({
    content: `window[${JSON.stringify(resultKey)}] = (() => {\n${body}\n})();`,
  });
  return page.evaluate((key) => {
    const result = window[key];
    delete window[key];
    return result;
  }, resultKey);
}

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

  test('exercises defensive planner helpers in the real classic-script lexical environment', async ({ page }) => {
    await page.goto('/');

    const result = await runClassicProbe(page, `
      const originalTasks = state.tasks;
      const originalEditor = state.editor;
      const originalPreviousFocus = state.previousFocus;
      const originalJsonSyncHandle = state.jsonSyncHandle;
      const originalStorageSetItem = Storage.prototype.setItem;
      const originalStorageGetItem = Storage.prototype.getItem;

      const emptyWarning = createTextCellContent('', '필수값 경고');
      const textWarning = createTextCellContent('값', '범위 경고');
      const warningAgain = createWarningBadge('두 번째 경고');
      const escaped = escapeHtml('<a data-x="1">A&B\\'s</a>');
      const kebab = toKebab('ActualProgress_Status');

      const progressLabels = [
        deriveProgressState({}, '2026-08-19').label,
        deriveProgressState({ plannedStartDate: '2026-08-01', plannedEndDate: '2026-08-10', actualStartDate: '2026-08-02', actualEndDate: '2026-08-09' }, '2026-08-19').label,
        deriveProgressState({ plannedStartDate: '2026-08-01', plannedEndDate: '2026-08-10' }, '2026-08-19').label,
        deriveProgressState({ plannedStartDate: '2026-08-01', plannedEndDate: '2026-08-30', actualStartDate: '2026-08-02' }, '2026-08-19').label,
        deriveProgressState({ plannedStartDate: '2026-08-20', plannedEndDate: '2026-08-30' }, '2026-08-19').label,
      ];

      const plannedRatios = [
        calculatePlannedProgressRatio('', '2026-08-01', '2026-08-10', 9),
        calculatePlannedProgressRatio('2026-08-01', '2026-08-01', '2026-08-10', 9),
        calculatePlannedProgressRatio('2026-08-11', '2026-08-01', '2026-08-10', 9),
        calculatePlannedProgressRatio('2026-08-05', '2026-08-01', '2026-08-10', 0),
        calculatePlannedProgressRatio('2026-08-05', '2026-08-01', '2026-08-10'),
      ];
      const durations = [
        calculateDurationDays('bad', '2026-08-10'),
        calculateDurationDays('2026-08-10', '2026-08-01'),
        calculateDurationDays('2026-08-01', '2026-08-10'),
      ];
      const rangeWarnings = [
        getDateRangeWarning('2026-08-10', '2026-08-01', '역전'),
        getDateRangeWarning('2026-08-01', '2026-08-10', '정상'),
      ];

      const childFromRoot = createChildDraft({ ...createEmptyTaskDraft(), depth: 1, phase: 'P', activity: 'A', task: 'T' });
      const childFromActivity = createChildDraft({ ...createEmptyTaskDraft(), depth: 2, phase: 'P', activity: 'A', task: 'T' });
      const sanitized = sanitizeDraft({ phase: 123, actualProgressStatus: 'not-an-option' });
      const nullValidation = validateDraft(null, 1);

      state.tasks = [];
      invalidateTaskIndexCache();
      insertTaskAfter({ ...createEmptyTaskDraft(), id: 'root-a', parentId: null, depth: 1, phase: 'A', expanded: true }, null);
      insertTaskAfter({ ...createEmptyTaskDraft(), id: 'root-b', parentId: null, depth: 1, phase: 'B', expanded: true }, 'missing-anchor');
      const missingDescendant = getLastDescendantId('missing-task');
      const missingRange = getTaskSubtreeRange('missing-task');
      reorderTaskWithinLevel('missing-task', 'root-a', true);
      handleInlineProgressChange({ target: { dataset: { inlineProgress: 'missing-task' }, value: '완료(100%)' } });
      handleRowAction('edit', 'missing-task');
      openEditor({ mode: 'edit', targetId: 'missing-task' });

      const focusButton = elements.openGanttButton;
      focusButton.focus();
      state.previousFocus = focusButton;
      elements.ganttModal.classList.remove('hidden');
      closeGanttModal();
      const ganttClosed = elements.ganttModal.classList.contains('hidden') && document.activeElement === focusButton;

      let persistenceToast = '';
      try {
        Storage.prototype.setItem = () => { throw new Error('forced quota'); };
        persistState({ syncCloud: false });
        persistenceToast = elements.toast.textContent;
      } finally {
        Storage.prototype.setItem = originalStorageSetItem;
      }

      let loadFallback = 'not-run';
      try {
        Storage.prototype.getItem = () => { throw new Error('forced read failure'); };
        loadFallback = loadLocalState();
      } finally {
        Storage.prototype.getItem = originalStorageGetItem;
      }

      state.jsonSyncHandle = null;
      const noHandleWrite = writeJsonSyncFile();

      let debouncedCalls = 0;
      const debounced = debounce(() => { debouncedCalls += 1; }, 1000);
      debounced.flush();
      debounced('queued');
      debounced.flush();

      state.tasks = originalTasks;
      state.editor = originalEditor;
      state.previousFocus = originalPreviousFocus;
      state.jsonSyncHandle = originalJsonSyncHandle;
      invalidateTaskIndexCache();
      renderAll();

      return {
        emptyWarning: emptyWarning.textContent,
        textWarning: textWarning.textContent,
        warningAgain: warningAgain.textContent,
        escaped,
        kebab,
        progressLabels,
        plannedRatios,
        durations,
        rangeWarnings,
        childFromRoot: { activity: childFromRoot.activity, task: childFromRoot.task },
        childFromActivity: { activity: childFromActivity.activity, task: childFromActivity.task },
        sanitized: { phase: sanitized.phase, actualProgressStatus: sanitized.actualProgressStatus },
        nullValidation,
        missingDescendant,
        missingRange,
        ganttClosed,
        persistenceToast,
        loadFallback,
        noHandleWriteIsPromise: Boolean(noHandleWrite && typeof noHandleWrite.then === 'function'),
        debouncedCalls,
      };
    `);

    expect(result.emptyWarning).toBe('필수값 경고');
    expect(result.textWarning).toContain('값');
    expect(result.textWarning).toContain('범위 경고');
    expect(result.warningAgain).toBe('두 번째 경고');
    expect(result.escaped).toBe('&lt;a data-x=&quot;1&quot;&gt;A&amp;B&#39;s&lt;/a&gt;');
    expect(result.kebab).toBe('actual-progress-status');
    expect(result.progressLabels).toHaveLength(5);
    expect(result.plannedRatios).toEqual([0, 0, 1, 1, expect.any(Number)]);
    expect(result.plannedRatios[4]).toBeGreaterThan(0);
    expect(result.plannedRatios[4]).toBeLessThan(1);
    expect(result.durations).toEqual([0, 0, 9]);
    expect(result.rangeWarnings).toEqual(['역전', '']);
    expect(result.childFromRoot).toEqual({ activity: '', task: '' });
    expect(result.childFromActivity).toEqual({ activity: 'A', task: '' });
    expect(result.sanitized).toEqual({ phase: '123', actualProgressStatus: '미착수(0%)' });
    expect(result.nullValidation).toEqual([]);
    expect(result.missingDescendant).toBe('missing-task');
    expect(result.missingRange).toBeNull();
    expect(result.ganttClosed).toBe(true);
    expect(result.persistenceToast).toContain('저장하지 못했습니다');
    expect(result.loadFallback).toBeNull();
    expect(result.noHandleWriteIsPromise).toBe(true);
    expect(result.debouncedCalls).toBe(1);
  });
});
