import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { test, expect } from '@playwright/test';

import { resolveBenchmarkBaseSha } from '../helpers/benchmark-base.mjs';

const ROW_COUNT = 5_000;
const SAMPLE_COUNT = 5;
const STORAGE_KEY = 'scopeweave:planner-state:v1';
const TARGET_IMPROVEMENT_PERCENT = 15;

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

function benchmarkBaseSha() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {};
  return resolveBenchmarkBaseSha({
    override: process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA,
    event,
  });
}

function readGitFile(commitSha, path) {
  const normalizedCommitSha = String(commitSha || '');
  if (!/^[a-f0-9]{40}$/.test(normalizedCommitSha)) {
    throw new Error(`Invalid benchmark base SHA: ${normalizedCommitSha || '<missing>'}`);
  }

  const spec = `${normalizedCommitSha}:${path}`;
  try {
    return execFileSync('git', ['show', spec], { encoding: 'utf8' });
  } catch {
    execFileSync('git', ['fetch', '--depth=1', 'origin', normalizedCommitSha], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return execFileSync('git', ['show', spec], { encoding: 'utf8' });
  }
}

async function measureRenderer(browser, { appSource = null, label }) {
  const context = await browser.newContext();
  const page = await context.newPage();

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

  if (appSource !== null) {
    await page.route('**/app.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: appSource,
      });
    });
  }

  await page.goto('/');
  const tasks = Array.from({ length: ROW_COUNT }, (_, index) => createTask(index));
  await page.evaluate(({ storageKey, seededTasks, benchmarkLabel }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      projectName: `ScopeWeave ${benchmarkLabel} benchmark`,
      baseDate: '2026-01-01',
      tasks: seededTasks,
    }));
  }, { storageKey: STORAGE_KEY, seededTasks: tasks, benchmarkLabel: label });

  const coldStartedAt = Date.now();
  await page.reload();
  await expect(page.locator('tbody tr[data-task-id]')).toHaveCount(ROW_COUNT);
  const coldLoadDurationMs = Date.now() - coldStartedAt;

  const evidence = await page.evaluate(async ({ sampleCount, benchmarkLabel }) => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const projectName = document.getElementById('project-name');
    const samples = [];

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const firstRowBeforeMetadataEdit = document.querySelector('tr[data-task-id="performance-0"]');
      const createElementsBefore = window.__scopeweaveCreateElementCalls();
      const heapBefore = performance.memory?.usedJSHeapSize ?? null;
      const startedAt = performance.now();
      projectName.focus();
      projectName.value = `ScopeWeave ${benchmarkLabel} benchmark ${sampleIndex}`;
      projectName.dispatchEvent(new Event('input', { bubbles: true }));
      projectName.blur();
      await nextFrame();
      samples.push({
        durationMs: performance.now() - startedAt,
        createElementCalls: window.__scopeweaveCreateElementCalls() - createElementsBefore,
        heapDeltaBytes: heapBefore === null ? null : performance.memory.usedJSHeapSize - heapBefore,
        liveDomNodes: document.getElementsByTagName('*').length,
        taskGridReused: firstRowBeforeMetadataEdit === document.querySelector('tr[data-task-id="performance-0"]'),
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
  }, { sampleCount: SAMPLE_COUNT, benchmarkLabel: label });

  await context.close();
  return { coldLoadDurationMs, evidence };
}

function summarizeMeasurement(measurement) {
  const durations = measurement.evidence.samples.map((sample) => sample.durationMs);
  const createElementCalls = measurement.evidence.samples.map((sample) => sample.createElementCalls);
  return {
    coldLoadDurationMs: measurement.coldLoadDurationMs,
    sampleDurationsMs: durations,
    medianDurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    medianCreateElementCalls: percentile(createElementCalls, 0.5),
    metadataTaskGridReused: measurement.evidence.samples.every((sample) => sample.taskGridReused),
    longTaskCount: measurement.evidence.longTasks.length,
    longestTaskMs: measurement.evidence.longTasks.length
      ? Math.max(...measurement.evidence.longTasks)
      : null,
    heapDeltaBytes: measurement.evidence.samples.map((sample) => sample.heapDeltaBytes),
    liveDomNodes: measurement.evidence.samples.map((sample) => sample.liveDomNodes),
    createElementCalls,
    editOpened: measurement.evidence.editOpened,
    inlineProgressChanged: measurement.evidence.inlineProgressChanged,
    dragReordered: measurement.evidence.dragReordered,
  };
}

test('5,000-row production rendering beats the exact protected-base median by at least 15%', async ({ browser }) => {
  test.setTimeout(180_000);

  const baseSha = benchmarkBaseSha();
  const baselineSource = readGitFile(baseSha, 'app.js');
  const optimizedMeasurement = await measureRenderer(browser, { label: 'optimized' });
  const optimized = summarizeMeasurement(optimizedMeasurement);
  const baseline = summarizeMeasurement(await measureRenderer(browser, {
    appSource: baselineSource,
    label: 'protected-base',
  }));
  const optimizationDeltaPercent = ((baseline.medianDurationMs - optimized.medianDurationMs)
    / baseline.medianDurationMs) * 100;
  const targetMet = optimizationDeltaPercent >= TARGET_IMPROVEMENT_PERCENT;

  const report = {
    rowCount: ROW_COUNT,
    sampleCount: SAMPLE_COUNT,
    protectedBaseSha: baseSha,
    protectedBaselineAvailable: true,
    targetPercent: TARGET_IMPROVEMENT_PERCENT,
    targetMet,
    optimizationDeltaPercent,
    baseline,
    optimized,
    comparisonNote: 'Both variants use the same browser, current static shell, 5,000-row state, and render trigger; only app.js is replaced with the immutable PR-base or previous protected-branch source for the baseline.',
  };
  console.log(`SCOPEWEAVE_RENDER_BENCHMARK ${JSON.stringify(report)}`);

  expect(optimizedMeasurement.evidence.samples).toHaveLength(SAMPLE_COUNT);
  expect(optimizedMeasurement.evidence.renderedRows).toBe(ROW_COUNT);
  expect(optimized.metadataTaskGridReused).toBe(true);
  for (const sample of optimizedMeasurement.evidence.samples) {
    expect(sample.createElementCalls).toBe(0);
  }
  expect(optimized.medianDurationMs).toBeGreaterThan(0);
  expect(optimized.p95DurationMs).toBeGreaterThanOrEqual(optimized.medianDurationMs);
  expect(optimized.editOpened).toBe(true);
  expect(optimized.inlineProgressChanged).toBe(true);
  expect(optimized.dragReordered).toBe(true);

  expect(baseline.medianDurationMs).toBeGreaterThan(0);
  expect(baseline.editOpened).toBe(true);
  expect(baseline.inlineProgressChanged).toBe(true);
  expect(baseline.dragReordered).toBe(true);
  expect(optimized.medianCreateElementCalls).toBeLessThan(baseline.medianCreateElementCalls);
  expect(
    optimizationDeltaPercent,
    `expected >=${TARGET_IMPROVEMENT_PERCENT}% median render improvement over ${baseSha}, got ${optimizationDeltaPercent.toFixed(2)}%`,
  ).toBeGreaterThanOrEqual(TARGET_IMPROVEMENT_PERCENT);
});
