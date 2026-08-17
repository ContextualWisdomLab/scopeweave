import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { test, expect } from '@playwright/test';

import { resolveBenchmarkBaseSha } from '../helpers/benchmark-base.mjs';

test.describe.configure({ retries: process.env.CI ? 2 : 0 });

const TASK_COUNT = 10_000;
const SAMPLE_COUNT = 7;
const WARMUP_COUNT = 3;
const TARGET_IMPROVEMENT_PERCENT = 15;
const BASE_DATE = '2026-02-15';
const CANDIDATE_APP_SOURCE = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');

const DATE_WINDOWS = Object.freeze([
  ['2026-01-01', '2026-01-02'],
  ['2026-01-02', '2026-01-12'],
  ['2026-02-01', '2026-03-01'],
  ['2026-02-15', '2026-02-15'],
]);

function protectedBaseSha() {
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

function instrumentMetricsSource(source) {
  const bootstrapCall = '\nbootstrap();';
  const bootstrapIndex = source.lastIndexOf(bootstrapCall);
  if (bootstrapIndex === -1) {
    throw new Error('Benchmark app source is missing the expected bootstrap call');
  }

  const withoutBootstrap = `${source.slice(0, bootstrapIndex)}${source.slice(bootstrapIndex + bootstrapCall.length)}`;
  return `${withoutBootstrap}\n\nwindow.__scopeweaveMetricsBenchmark = Object.freeze({\n  seed(tasks, baseDate) {\n    state.tasks = tasks;\n    state.baseDate = baseDate;\n  },\n  compute() {\n    return computeTaskMetrics();\n  },\n});\n`;
}

function createTask(index) {
  const [plannedStartDate, plannedEndDate] = DATE_WINDOWS[index % DATE_WINDOWS.length];
  return {
    id: `metrics-performance-${index}`,
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
    owner: `owner-${index % 17}`,
    supportTeam: '',
    plannedStartDate,
    plannedEndDate,
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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measureMetrics(browser, { appSource, label }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const instrumentedSource = instrumentMetricsSource(appSource);

  await page.route('**/app.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: instrumentedSource,
    });
  });

  await page.goto('/');
  const tasks = Array.from({ length: TASK_COUNT }, (_, index) => createTask(index));

  const result = await page.evaluate(async ({ seededTasks, baseDate, sampleCount, warmupCount }) => {
    const benchmark = window.__scopeweaveMetricsBenchmark;
    if (!benchmark) throw new Error('metrics benchmark bridge did not initialize');
    benchmark.seed(seededTasks, baseDate);

    for (let warmup = 0; warmup < warmupCount; warmup += 1) {
      benchmark.compute();
    }

    const samples = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const startedAt = performance.now();
      benchmark.compute();
      samples.push(performance.now() - startedAt);
    }

    const metrics = benchmark.compute();
    const entries = Array.from(metrics.byTask, ([taskId, taskMetrics]) => [
      taskId,
      taskMetrics.durationDays,
      taskMetrics.weightRatio,
      taskMetrics.plannedProgressRatio,
      taskMetrics.actualProgressRatio,
      taskMetrics.weightedPlannedRatio,
      taskMetrics.weightedActualRatio,
      taskMetrics.progressState.label,
      taskMetrics.progressState.className,
      taskMetrics.plannedDateWarning,
      taskMetrics.actualDateWarning,
    ]);
    const snapshot = JSON.stringify({
      totalDays: metrics.totalDays,
      totalWeightedPlannedRatio: metrics.totalWeightedPlannedRatio,
      totalWeightedActualRatio: metrics.totalWeightedActualRatio,
      entries,
    });
    const digestBytes = new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(snapshot),
    ));
    const digest = Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

    return {
      samples,
      digest,
      totalDays: metrics.totalDays,
      byTaskSize: metrics.byTask.size,
      totalWeightedPlannedRatio: metrics.totalWeightedPlannedRatio,
      totalWeightedActualRatio: metrics.totalWeightedActualRatio,
    };
  }, {
    seededTasks: tasks,
    baseDate: BASE_DATE,
    sampleCount: SAMPLE_COUNT,
    warmupCount: WARMUP_COUNT,
  });

  await context.close();
  return {
    label,
    ...result,
    medianDurationMs: median(result.samples),
  };
}

test('10,000-task metric computation preserves exact semantics and beats the protected base', async ({ browser }) => {
  test.setTimeout(120_000);

  const baseSha = protectedBaseSha();
  const baselineSource = readGitFile(baseSha, 'app.js');
  const baseline = await measureMetrics(browser, { appSource: baselineSource, label: 'protected-base' });
  const optimized = await measureMetrics(browser, { appSource: CANDIDATE_APP_SOURCE, label: 'candidate' });

  expect(optimized.byTaskSize).toBe(TASK_COUNT);
  expect(optimized.samples).toHaveLength(SAMPLE_COUNT);
  expect(optimized.medianDurationMs).toBeGreaterThan(0);

  expect(baseline.byTaskSize).toBe(TASK_COUNT);
  expect(optimized.digest).toBe(baseline.digest);
  expect(optimized.totalDays).toBe(baseline.totalDays);
  expect(optimized.totalWeightedPlannedRatio).toBe(baseline.totalWeightedPlannedRatio);
  expect(optimized.totalWeightedActualRatio).toBe(baseline.totalWeightedActualRatio);

  const optimizationDeltaPercent = ((baseline.medianDurationMs - optimized.medianDurationMs)
    / baseline.medianDurationMs) * 100;
  expect(
    optimizationDeltaPercent,
    `expected >=${TARGET_IMPROVEMENT_PERCENT}% median computeTaskMetrics improvement over ${baseSha}, got ${optimizationDeltaPercent.toFixed(2)}%`,
  ).toBeGreaterThanOrEqual(TARGET_IMPROVEMENT_PERCENT);

  console.log(`SCOPEWEAVE_METRICS_BENCHMARK ${JSON.stringify({
    taskCount: TASK_COUNT,
    sampleCount: SAMPLE_COUNT,
    warmupCount: WARMUP_COUNT,
    protectedBaseSha: baseSha,
    protectedBaselineAvailable: true,
    targetImprovementPercent: TARGET_IMPROVEMENT_PERCENT,
    optimizationDeltaPercent,
    baseline,
    optimized,
  })}`);
});
