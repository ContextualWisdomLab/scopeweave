// Behavioral coverage for computeTaskMetrics after hot-path cache changes.
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
;globalThis.__taskMetricExports = { computeTaskMetrics, state };
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

const { computeTaskMetrics, state } = loadMetrics();

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

console.log('✓ task metric cache behavior tests passed');
