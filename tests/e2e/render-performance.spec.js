import { test, expect } from '@playwright/test';

const ROW_COUNT = 5_000;
const SAMPLE_COUNT = 5;
const STORAGE_KEY = 'scopeweave:planner-state:v1';

function percentile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1);
  return sorted[index];
}

function createTask(index) {
  return {
    id: `performance-${index}`,
    parentId: null,
    depth: 1,
    expanded: true,
    pendingDelete: false,
    isSynthetic: false,
    phase: `Phase ${index}`,
    activity: '',
    task: '',
    categoryLarge: '',
    categoryMedium: '',
    documentName: '',
    owner: 'same-owner',
    supportTeam: '',
    plannedStartDate: '2026-01-01',
    plannedEndDate: '2026-01-02',
    actualProgressStatus: '미착수(0%)',
    actualStartDate: '',
    actualEndDate: '',
    predecessors: '',
    budget: '',
    actualCost: '',
    sprint: '',
    storyPoints: '',
  };
}

test('5,000-row production rendering remains measurable and interactive', async ({ page }) => {
  test.setTimeout(120_000);

  await page.addInitScript(() => {
    const originalCreateElement = Document.prototype.createElement;
    let createElementCalls = 0;
    Document.prototype.createElement = function (...args) {
      createElementCalls += 1;
      return originalCreateElement.apply(this, args);
    };
    window.__scopeweaveCreateElementCalls = () => createElementCalls;
    window.__scopeweaveLongTasks = [];
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__scopeweaveLongTasks.push(entry.duration);
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    }
  });

  await page.goto('/');
  const tasks = Array.from({ length: ROW_COUNT }, (_, index) => createTask(index));
  await page.evaluate(({ storageKey, seededTasks }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      projectName: 'ScopeWeave benchmark',
      baseDate: '2026-01-01',
      tasks: seededTasks,
    }));
  }, { storageKey: STORAGE_KEY, seededTasks: tasks });

  const coldStartedAt = Date.now();
  await page.reload();
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(ROW_COUNT);
  const coldLoadDurationMs = Date.now() - coldStartedAt;

  const evidence = await page.evaluate(async ({ sampleCount }) => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const projectName = document.getElementById('project-name');
    const samples = [];

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const createElementsBefore = window.__scopeweaveCreateElementCalls();
      const heapBefore = performance.memory?.usedJSHeapSize ?? null;
      const startedAt = performance.now();
      projectName.focus();
      projectName.value = `ScopeWeave benchmark ${sampleIndex}`;
      projectName.dispatchEvent(new Event('input', { bubbles: true }));
      projectName.blur();
      await nextFrame();
      samples.push({
        durationMs: performance.now() - startedAt,
        createElementCalls: window.__scopeweaveCreateElementCalls() - createElementsBefore,
        heapDeltaBytes: heapBefore === null ? null : performance.memory.usedJSHeapSize - heapBefore,
        liveDomNodes: document.getElementsByTagName('*').length,
      });
    }

    const firstRow = document.querySelector('tr[data-task-id="performance-0"]');
    firstRow.querySelector('button[data-action="edit"]').click();
    const editOpened = Boolean(document.querySelector('form[data-editor-form="true"]'));
    document.querySelector('button[data-action="cancel-editor"]').click();

    let progressSelect = document.querySelector('select[data-inline-progress="performance-0"]');
    const nextProgress = progressSelect.options[Math.min(1, progressSelect.options.length - 1)].value;
    progressSelect.value = nextProgress;
    progressSelect.dispatchEvent(new Event('change', { bubbles: true }));
    progressSelect = document.querySelector('select[data-inline-progress="performance-0"]');
    const inlineProgressChanged = progressSelect.value === nextProgress;

    const rowIds = () => Array.from(document.querySelectorAll('tr[data-task-id]'), (row) => row.dataset.taskId);
    const orderBeforeDrag = rowIds().slice(0, 2);
    const sourceRow = document.querySelector('tr[data-task-id="performance-0"]');
    const targetRow = document.querySelector('tr[data-task-id="performance-1"]');
    const dataTransfer = new DataTransfer();
    sourceRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    const targetRect = targetRow.getBoundingClientRect();
    targetRow.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientY: targetRect.bottom,
      dataTransfer,
    }));
    targetRow.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientY: targetRect.bottom,
      dataTransfer,
    }));
    sourceRow.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    await nextFrame();
    const orderAfterDrag = rowIds().slice(0, 2);

    return {
      samples,
      longTasks: window.__scopeweaveLongTasks,
      renderedRows: document.querySelectorAll('tr[data-task-id]').length,
      editOpened,
      inlineProgressChanged,
      dragReordered: orderBeforeDrag.join(',') !== orderAfterDrag.join(','),
    };
  }, { sampleCount: SAMPLE_COUNT });

  const durations = evidence.samples.map((sample) => sample.durationMs);
  const report = {
    rowCount: ROW_COUNT,
    sampleCount: SAMPLE_COUNT,
    coldLoadDurationMs,
    sampleDurationsMs: durations,
    medianDurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    protectedBaselineAvailable: false,
    targetPercent: 15,
    targetMet: null,
    optimizationDeltaPercent: null,
    comparisonNote: 'No protected-base browser A/B was run; do not interpret cold-load versus warm-render timings as an optimization delta.',
    longTaskCount: evidence.longTasks.length,
    longestTaskMs: evidence.longTasks.length ? Math.max(...evidence.longTasks) : null,
    heapDeltaBytes: evidence.samples.map((sample) => sample.heapDeltaBytes),
    liveDomNodes: evidence.samples.map((sample) => sample.liveDomNodes),
    createElementCalls: evidence.samples.map((sample) => sample.createElementCalls),
    editOpened: evidence.editOpened,
    inlineProgressChanged: evidence.inlineProgressChanged,
    dragReordered: evidence.dragReordered,
  };
  console.log(`SCOPEWEAVE_RENDER_BENCHMARK ${JSON.stringify(report)}`);

  expect(evidence.samples).toHaveLength(SAMPLE_COUNT);
  expect(evidence.renderedRows).toBe(ROW_COUNT);
  expect(report.medianDurationMs).toBeGreaterThan(0);
  expect(report.p95DurationMs).toBeGreaterThanOrEqual(report.medianDurationMs);
  expect(evidence.editOpened).toBe(true);
  expect(evidence.inlineProgressChanged).toBe(true);
  expect(evidence.dragReordered).toBe(true);
});
