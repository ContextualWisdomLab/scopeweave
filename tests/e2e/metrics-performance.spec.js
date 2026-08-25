import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { test, expect } from '@playwright/test';

import {
  counterbalancedBenchmarkRounds,
  resolveBenchmarkBaseSha,
  resolveBenchmarkCandidateSha,
  summarizeCounterbalancedSamples,
} from '../helpers/benchmark-base.mjs';

test.describe.configure({ retries: process.env.CI ? 2 : 0 });

const TASK_COUNT = 10_000;
const SAMPLE_COUNT = 7;
const WARMUP_COUNT = 3;
const TARGET_IMPROVEMENT_PERCENT = 15;
const BASE_DATE = '2026-02-15';

const DATE_WINDOWS = Object.freeze([
  ['2026-01-01', '2026-01-02'],
  ['2026-01-02', '2026-01-12'],
  ['2026-02-01', '2026-03-01'],
  ['2026-02-15', '2026-02-15'],
]);

function githubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  return eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {};
}

function readGitFile(commitSha, path) {
  const normalizedCommitSha = String(commitSha || '');
  if (!/^[a-f0-9]{40}$/.test(normalizedCommitSha)) {
    throw new Error(`Invalid benchmark commit SHA: ${normalizedCommitSha || '<missing>'}`);
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

async function measureMetrics(browser, { appSource, label }) {
  const context = await browser.newContext();
  try {
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

    return { label, ...result };
  } finally {
    await context.close();
  }
}

test('10,000-task metric computation preserves exact semantics and beats the protected base', async ({ browser }) => {
  test.setTimeout(240_000);

  const event = githubEvent();
  const baseSha = resolveBenchmarkBaseSha({
    override: process.env.SCOPEWEAVE_BENCHMARK_BASE_SHA,
    event,
  });
  const candidateSha = resolveBenchmarkCandidateSha({
    override: process.env.SCOPEWEAVE_BENCHMARK_HEAD_SHA,
    event,
  });
  const sourceByLabel = new Map([
    ['protected-base', readGitFile(baseSha, 'app.js')],
    ['candidate', readGitFile(candidateSha, 'app.js')],
  ]);
  const measurementOrder = counterbalancedBenchmarkRounds();
  const measurements = [];

  for (const round of measurementOrder) {
    for (const label of round) {
      measurements.push(await measureMetrics(browser, {
        appSource: sourceByLabel.get(label),
        label,
      }));
    }
  }

  const semanticReference = measurements[0];
  for (const measurement of measurements) {
    expect(measurement.byTaskSize).toBe(TASK_COUNT);
    expect(measurement.samples).toHaveLength(SAMPLE_COUNT);
    expect(measurement.samples.every((duration) => duration > 0)).toBe(true);
    expect(measurement.digest).toBe(semanticReference.digest);
    expect(measurement.totalDays).toBe(semanticReference.totalDays);
    expect(measurement.totalWeightedPlannedRatio).toBe(semanticReference.totalWeightedPlannedRatio);
    expect(measurement.totalWeightedActualRatio).toBe(semanticReference.totalWeightedActualRatio);
  }

  const summary = summarizeCounterbalancedSamples(measurements);
  expect(summary.baselineMedianDurationMs).toBeGreaterThan(0);
  expect(summary.candidateMedianDurationMs).toBeGreaterThan(0);
  expect(
    summary.improvementPercent,
    `expected >=${TARGET_IMPROVEMENT_PERCENT}% counterbalanced median computeTaskMetrics improvement for exact head ${candidateSha} over ${baseSha}, got ${summary.improvementPercent.toFixed(2)}%`,
  ).toBeGreaterThanOrEqual(TARGET_IMPROVEMENT_PERCENT);

  const sharedSemanticEvidence = {
    digest: semanticReference.digest,
    totalDays: semanticReference.totalDays,
    byTaskSize: semanticReference.byTaskSize,
    totalWeightedPlannedRatio: semanticReference.totalWeightedPlannedRatio,
    totalWeightedActualRatio: semanticReference.totalWeightedActualRatio,
  };
  console.log(`SCOPEWEAVE_METRICS_BENCHMARK ${JSON.stringify({
    taskCount: TASK_COUNT,
    sampleCountPerMeasurement: SAMPLE_COUNT,
    warmupCountPerMeasurement: WARMUP_COUNT,
    measurementOrder,
    protectedBaseSha: baseSha,
    exactContributorHeadSha: candidateSha,
    protectedBaselineAvailable: true,
    targetImprovementPercent: TARGET_IMPROVEMENT_PERCENT,
    optimizationDeltaPercent: summary.improvementPercent,
    baseline: {
      samples: summary.baselineSamples,
      medianDurationMs: summary.baselineMedianDurationMs,
      ...sharedSemanticEvidence,
    },
    optimized: {
      samples: summary.candidateSamples,
      medianDurationMs: summary.candidateMedianDurationMs,
      ...sharedSemanticEvidence,
    },
  })}`);
});
