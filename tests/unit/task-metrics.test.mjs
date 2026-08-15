// Behavioral and measurement coverage for computeTaskMetrics hot-path changes.
// app.js is browser-first; evaluate it under vm and export only the metric seam.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const appJsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js');

function loadMetrics() {
  let source = fs.readFileSync(appJsPath, 'utf8');
  source = source.replace(/^\s*bootstrap\(\);\s*$/m, ';');
  source += `
function __computeTaskMetricsReference() {
  const durationCache = new Map();
  const totalDays = state.tasks.reduce((sum, task) => {
    const duration = calculateDurationDays(task.plannedStartDate, task.plannedEndDate);
    durationCache.set(task.id, duration);
    return sum + duration;
  }, 0);

  const baseDate = state.baseDate;
  const byTask = new Map();
  let totalWeightedPlannedRatio = 0;
  let totalWeightedActualRatio = 0;

  state.tasks.forEach((task) => {
    const durationDays = durationCache.get(task.id);
    const weightRatio = totalDays > 0 ? durationDays / totalDays : 0;
    const plannedProgressRatio = calculatePlannedProgressRatio(baseDate, task.plannedStartDate, task.plannedEndDate, durationDays);
    const actualProgressRatio = (ACTUAL_PROGRESS_MAP[task.actualProgressStatus] || 0) / 100;
    const weightedPlannedRatio = weightRatio * plannedProgressRatio;
    const weightedActualRatio = weightRatio * actualProgressRatio;
    const plannedDateWarning = getDateRangeWarning(task.plannedStartDate, task.plannedEndDate, '계획종료일이 시작일보다 빠릅니다.');
    const actualDateWarning = getDateRangeWarning(task.actualStartDate, task.actualEndDate, '실적종료일이 시작일보다 빠릅니다.');
    const progressState = deriveProgressState(task, baseDate);

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
      actualDateWarning,
    });
  });

  return { totalDays, totalWeightedPlannedRatio, totalWeightedActualRatio, byTask };
}

globalThis.__taskMetricExports = {
  computeTaskMetrics,
  computeTaskMetricsReference: __computeTaskMetricsReference,
  state,
};
`;

  const classList = {
    contains: () => false,
    add() {},
    remove() {},
    toggle() {},
  };
  const dummyElement = new Proxy(
    { classList, style: {}, value: '', textContent: '', innerHTML: '', checked: false },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => dummyElement;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  const sandbox = {
    window: windowStub,
    self: windowStub,
    document: {
      getElementById: () => dummyElement,
      createElement: () => dummyElement,
      body: dummyElement,
      addEventListener() {},
      querySelector: () => dummyElement,
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    fetch: () => Promise.reject(new Error('fetch disabled in task metric harness')),
    AbortController: globalThis.AbortController,
    crypto: globalThis.crypto,
    Int32Array,
    Uint32Array,
    console,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    WeakMap,
    Symbol,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    URL: globalThis.URL,
    Proxy,
    Reflect,
    Promise,
  };
  sandbox.globalThis = sandbox;
  windowStub.window = windowStub;

  vm.runInContext(source, vm.createContext(sandbox), { filename: appJsPath });
  if (!sandbox.__taskMetricExports?.computeTaskMetrics) {
    throw new Error('Failed to extract task metric exports from app.js');
  }
  return sandbox.__taskMetricExports;
}

function closeTo(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: expected ${expected}, got ${actual}`);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measureMedianMs(operation, iterations = 5) {
  for (let index = 0; index < 2; index += 1) operation();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    operation();
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  return median(samples);
}

const { computeTaskMetrics, computeTaskMetricsReference, state } = loadMetrics();

state.baseDate = '2026-08-12';
state.tasks = [
  {
    id: 'task-alpha',
    plannedStartDate: '2026-08-10',
    plannedEndDate: '2026-08-14',
    actualProgressStatus: '진행(50%)',
    actualStartDate: '',
    actualEndDate: '',
  },
  {
    id: '9007199254740993',
    plannedStartDate: '2026-08-13',
    plannedEndDate: '2026-08-15',
    actualProgressStatus: 'PM확인(100%)',
    actualStartDate: '',
    actualEndDate: '',
  },
];

let metrics = computeTaskMetrics();
assert.equal(metrics.totalDays, 8, 'inclusive planned durations are summed exactly');
assert.equal(metrics.byTask.size, 2, 'metrics remain keyed by the original opaque task identifiers');
assert.equal(metrics.byTask.get('task-alpha').durationDays, 5, 'first task keeps its own duration');
assert.equal(metrics.byTask.get('9007199254740993').durationDays, 3, 'opaque numeric-looking ids do not become cache indexes');
closeTo(metrics.byTask.get('task-alpha').weightRatio, 5 / 8, 'first task weight');
closeTo(metrics.byTask.get('9007199254740993').weightRatio, 3 / 8, 'second task weight');
closeTo(metrics.byTask.get('task-alpha').plannedProgressRatio, 3 / 5, 'planned progress uses inclusive elapsed days');
closeTo(metrics.byTask.get('9007199254740993').plannedProgressRatio, 0, 'future task planned progress remains zero');
closeTo(metrics.totalWeightedPlannedRatio, 3 / 8, 'weighted planned progress preserves prior semantics');
closeTo(metrics.totalWeightedActualRatio, 11 / 16, 'weighted actual progress preserves prior semantics');

const referenceMetrics = computeTaskMetricsReference();
assert.equal(metrics.totalDays, referenceMetrics.totalDays, 'optimized total duration matches the protected-base algorithm');
closeTo(metrics.totalWeightedPlannedRatio, referenceMetrics.totalWeightedPlannedRatio, 'optimized planned aggregate parity');
closeTo(metrics.totalWeightedActualRatio, referenceMetrics.totalWeightedActualRatio, 'optimized actual aggregate parity');

state.tasks = [
  {
    id: 'invalid-date-task',
    plannedStartDate: 'not-a-date',
    plannedEndDate: '2026-08-15',
    actualProgressStatus: '미착수(0%)',
    actualStartDate: '',
    actualEndDate: '',
  },
];
metrics = computeTaskMetrics();
assert.equal(metrics.totalDays, 0, 'invalid persisted dates retain the existing zero-duration fail-safe');
assert.equal(metrics.byTask.get('invalid-date-task').durationDays, 0, 'typed cache does not manufacture a duration');
assert.equal(metrics.byTask.get('invalid-date-task').weightRatio, 0, 'zero total duration does not produce NaN or Infinity');
assert.equal(Number.isFinite(metrics.totalWeightedPlannedRatio), true, 'aggregate planned metric remains finite');
assert.equal(Number.isFinite(metrics.totalWeightedActualRatio), true, 'aggregate actual metric remains finite');

state.tasks = [];
metrics = computeTaskMetrics();
assert.equal(metrics.totalDays, 0, 'empty plans remain supported');
assert.equal(metrics.byTask.size, 0, 'empty plans produce no task metrics');
assert.equal(metrics.totalWeightedPlannedRatio, 0, 'empty planned aggregate is zero');
assert.equal(metrics.totalWeightedActualRatio, 0, 'empty actual aggregate is zero');

const statuses = ['미착수(0%)', '진행(50%)', 'PM확인(100%)'];
state.baseDate = '2026-01-15';
state.tasks = Array.from({ length: 10_000 }, (_, index) => {
  const day = String((index % 28) + 1).padStart(2, '0');
  const status = statuses[index % statuses.length];
  return {
    id: `benchmark-task-${index}`,
    plannedStartDate: '2026-01-01',
    plannedEndDate: `2026-01-${day}`,
    actualProgressStatus: status,
    actualStartDate: status === '미착수(0%)' ? '' : '2026-01-02',
    actualEndDate: status === 'PM확인(100%)' ? `2026-01-${day}` : '',
  };
});

const benchmarkReference = computeTaskMetricsReference();
const benchmarkCandidate = computeTaskMetrics();
assert.equal(benchmarkCandidate.totalDays, benchmarkReference.totalDays, '10k-task candidate preserves reference total duration');
closeTo(
  benchmarkCandidate.totalWeightedPlannedRatio,
  benchmarkReference.totalWeightedPlannedRatio,
  '10k-task candidate preserves reference planned aggregate',
);
closeTo(
  benchmarkCandidate.totalWeightedActualRatio,
  benchmarkReference.totalWeightedActualRatio,
  '10k-task candidate preserves reference actual aggregate',
);

const referenceMedianMs = measureMedianMs(computeTaskMetricsReference);
const candidateMedianMs = measureMedianMs(computeTaskMetrics);
const improvementPct = referenceMedianMs > 0
  ? ((referenceMedianMs - candidateMedianMs) / referenceMedianMs) * 100
  : 0;
assert.equal(Number.isFinite(referenceMedianMs), true, 'reference benchmark is finite');
assert.equal(Number.isFinite(candidateMedianMs), true, 'candidate benchmark is finite');
console.log(JSON.stringify({
  benchmark: 'computeTaskMetrics',
  tasks: state.tasks.length,
  iterations: 5,
  referenceMedianMs: Number(referenceMedianMs.toFixed(3)),
  candidateMedianMs: Number(candidateMedianMs.toFixed(3)),
  improvementPct: Number(improvementPct.toFixed(2)),
}));

console.log('✓ task metric cache behavior and benchmark evidence passed');
