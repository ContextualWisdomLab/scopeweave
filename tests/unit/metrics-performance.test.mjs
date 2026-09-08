import v8 from 'node:v8';
import test from 'node:test';
import assert from 'node:assert/strict';

// Mock state and global ACTUAL_PROGRESS_MAP just enough for testing computeTaskMetrics logic
globalThis.ACTUAL_PROGRESS_MAP = {
  '진행': 50,
  '완료': 100
};

// We will mock the required helper functions since we only want to test computeTaskMetrics and we are not in browser
globalThis.calculateDurationDays = (start, end) => {
  if (!start || !end || start === 'invalid') return 0;
  if (start === '2026-09-01') return 5;
  if (start === '2026-09-06') return 10;
  return 20;
};
globalThis.calculatePlannedProgressRatio = () => 0.5;
globalThis.getDateRangeWarning = () => '';
globalThis.deriveProgressState = () => ({});

// A lightweight mock of the state object
globalThis.state = {
  tasks: [],
  baseDate: '2026-09-08'
};

// Paste the computeTaskMetrics function exactly as it appears in app.js
function computeTaskMetrics() {
  const tasks = globalThis.state.tasks;
  const len = tasks.length;
  const durationCache = new Map();

  let totalDays = 0;
  for (let i = 0; i < len; i++) {
    const task = tasks[i];
    const duration = globalThis.calculateDurationDays(task.plannedStartDate, task.plannedEndDate);
    durationCache.set(task.id, duration);
    totalDays += duration;
  }

  const baseDate = globalThis.state.baseDate;
  const byTask = new Map();
  let totalWeightedPlannedRatio = 0;
  let totalWeightedActualRatio = 0;

  for (let i = 0; i < len; i++) {
    const task = tasks[i];
    const durationDays = durationCache.get(task.id);
    const weightRatio = totalDays > 0 ? durationDays / totalDays : 0;
    const plannedProgressRatio = globalThis.calculatePlannedProgressRatio(baseDate, task.plannedStartDate, task.plannedEndDate, durationDays);
    const actualProgressRatio = (globalThis.ACTUAL_PROGRESS_MAP[task.actualProgressStatus] || 0) / 100;
    const weightedPlannedRatio = weightRatio * plannedProgressRatio;
    const weightedActualRatio = weightRatio * actualProgressRatio;
    const plannedDateWarning = globalThis.getDateRangeWarning(task.plannedStartDate, task.plannedEndDate, '계획종료일이 시작일보다 빠릅니다.');
    const actualDateWarning = globalThis.getDateRangeWarning(task.actualStartDate, task.actualEndDate, '실적종료일이 시작일보다 빠릅니다.');
    const progressState = globalThis.deriveProgressState(task, baseDate);

    totalWeightedPlannedRatio += weightedPlannedRatio;
    totalWeightedActualRatio += weightedActualRatio;

    byTask.set(task.id, {
      durationDays,
      weightRatio,
      plannedProgressRatio,
      actualProgressRatio,
      weightedPlannedRatio,
      weightedActualRatio,
      progressState,
      plannedDateWarning,
      actualDateWarning
    });
  }

  return {
    totalDays,
    totalWeightedPlannedRatio,
    totalWeightedActualRatio,
    byTask
  };
}

test('computeTaskMetrics preserves duplicate ID mapping behavior', (t) => {
  globalThis.state.tasks = [
    { id: '1', plannedStartDate: '2026-09-01', plannedEndDate: '2026-09-05', actualProgressStatus: '완료' },
    // Duplicate ID 1
    { id: '1', plannedStartDate: '2026-09-06', plannedEndDate: '2026-09-15', actualProgressStatus: '진행' }
  ];
  const result = computeTaskMetrics();

  assert.equal(result.totalDays, 15);
  assert.equal(result.byTask.size, 1);
  const taskMetric = result.byTask.get('1');
  assert.equal(taskMetric.durationDays, 10); // Uses the duration of the last duplicate ID due to Map override
});


test('computeTaskMetrics performance benchmark', { timeout: 30000 }, (t) => {

  const massiveTasks = [];
  for (let i = 0; i < 50000; i++) {
    massiveTasks.push({
      id: `task-${i}`,
      plannedStartDate: '2026-09-01',
      plannedEndDate: '2026-09-10',
      actualProgressStatus: i % 2 === 0 ? '완료' : '진행'
    });
  }
  globalThis.state.tasks = massiveTasks;

  for (let i = 0; i < 5; i++) {
    computeTaskMetrics();
  }

  const samples = 100;
  const times = [];
  let peakHeap = 0;

  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    computeTaskMetrics();
    times.push(performance.now() - start);

    const heapStats = v8.getHeapStatistics();
    if (heapStats.used_heap_size > peakHeap) {
      peakHeap = heapStats.used_heap_size;
    }
  }

  times.sort((a, b) => a - b);
  const median = times[Math.floor(samples / 2)];
  const p95 = times[Math.floor(samples * 0.95)];

  console.log(`\nBenchmark Results (50,000 tasks, ${samples} samples):`);
  console.log(`Median CPU time: ${median.toFixed(2)} ms`);
  console.log(`P95 CPU time: ${p95.toFixed(2)} ms`);
  console.log(`Peak Heap Size (GC / Alloc): ${(peakHeap / 1024 / 1024).toFixed(2)} MB`);

  assert.ok(median < 250, 'Median execution time should be under 250ms for 50k tasks');
});
