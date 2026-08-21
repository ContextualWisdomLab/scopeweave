import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  createStripeReconciliationScheduler,
  stripeReconciliationPollIntervalMs,
} from '../../server/stripe_reconciliation_scheduler.mjs';
import { bindScopeWeaveRuntime } from '../../server/server_runtime.mjs';

function createFakeTimers() {
  let nextId = 0;
  const pending = new Map();
  const cancelled = [];

  function schedule(callback, delayMs) {
    const id = ++nextId;
    pending.set(id, { callback, delayMs });
    return id;
  }

  function cancel(id) {
    cancelled.push(id);
    pending.delete(id);
  }

  async function runNext() {
    const next = pending.entries().next().value;
    assert.ok(next, 'expected one pending scheduler callback');
    const [id, entry] = next;
    pending.delete(id);
    await entry.callback();
    return entry.delayMs;
  }

  function beginNext() {
    const next = pending.entries().next().value;
    assert.ok(next, 'expected one pending scheduler callback');
    const [id, entry] = next;
    pending.delete(id);
    return { delayMs: entry.delayMs, promise: entry.callback() };
  }

  return { schedule, cancel, runNext, beginNext, pending, cancelled };
}

test('poll interval parsing is bounded and rejects ambiguous configuration', () => {
  assert.equal(stripeReconciliationPollIntervalMs(undefined), 1_000);
  assert.equal(stripeReconciliationPollIntervalMs('250'), 250);
  assert.equal(stripeReconciliationPollIntervalMs('60000'), 60_000);

  for (const invalid of ['', ' 250', '250 ', '1e3', '99', '60001', '-1', 'NaN']) {
    assert.throws(
      () => stripeReconciliationPollIntervalMs(invalid),
      (error) => error?.code === 'stripe_reconciliation_scheduler_interval_invalid',
      `expected ${JSON.stringify(invalid)} to fail closed`,
    );
  }
});

test('scheduler never overlaps reconciliation and stop during an in-flight run prevents rescheduling', async () => {
  const timers = createFakeTimers();
  let resolveRun;
  let calls = 0;
  const runGate = new Promise((resolve) => {
    resolveRun = resolve;
  });
  const scheduler = createStripeReconciliationScheduler({
    runOnce: async () => {
      calls += 1;
      await runGate;
      return { status: 'idle' };
    },
    intervalMs: 250,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false, 'start is idempotent');
  assert.equal(timers.pending.size, 1);
  const first = timers.beginNext();
  assert.equal(first.delayMs, 0, 'startup schedules an immediate first pass without blocking boot');
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(timers.pending.size, 0, 'no second timer exists while reconciliation is in flight');

  assert.equal(scheduler.stop(), true);
  assert.equal(scheduler.stop(), false, 'stop is idempotent');
  resolveRun();
  await first.promise;
  assert.equal(timers.pending.size, 0, 'an in-flight completion cannot resurrect a stopped scheduler');
});

test('scheduler sanitizes iteration failures and continues with one bounded delayed retry', async () => {
  const timers = createFakeTimers();
  const failures = [];
  let calls = 0;
  const scheduler = createStripeReconciliationScheduler({
    runOnce: async () => {
      calls += 1;
      if (calls === 1) throw new Error('provider failed with sk_live_must_not_escape');
      return { status: 'idle' };
    },
    intervalMs: 500,
    schedule: timers.schedule,
    cancel: timers.cancel,
    onFailure: (...args) => failures.push(args),
  });

  scheduler.start();
  assert.equal(await timers.runNext(), 0);
  assert.deepEqual(failures, [['stripe_reconciliation_scheduler_iteration_failed']]);
  assert.equal(timers.pending.size, 1);
  const retryDelay = await timers.runNext();
  assert.equal(retryDelay, 500);
  assert.equal(calls, 2);
  assert.equal(timers.pending.size, 1, 'successful idle passes keep bounded polling alive');
  scheduler.stop();
  assert.equal(timers.pending.size, 0);
});

test('failure reporting cannot crash or multiply the scheduler loop', async () => {
  const timers = createFakeTimers();
  const scheduler = createStripeReconciliationScheduler({
    runOnce: async () => {
      throw new Error('causal runtime failure');
    },
    intervalMs: 250,
    schedule: timers.schedule,
    cancel: timers.cancel,
    onFailure: () => {
      throw new Error('broken telemetry sink');
    },
  });

  scheduler.start();
  await timers.runNext();
  assert.equal(timers.pending.size, 1);
  assert.equal(await timers.runNext(), 250);
  assert.equal(timers.pending.size, 1);
  scheduler.stop();
});

test('stopping a waiting scheduler cancels the exact pending timer', () => {
  const timers = createFakeTimers();
  const scheduler = createStripeReconciliationScheduler({
    runOnce: async () => ({ status: 'idle' }),
    intervalMs: 1_000,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  scheduler.start();
  const timerId = [...timers.pending.keys()][0];
  scheduler.stop();
  assert.deepEqual(timers.cancelled, [timerId]);
  assert.equal(timers.pending.size, 0);
});

test('runtime binding starts reconciliation and drains it before closing on termination signals', () => {
  const order = [];
  const signalTarget = new EventEmitter();
  const scheduler = {
    start() {
      order.push('scheduler:start');
      return true;
    },
    stop() {
      order.push('scheduler:stop');
      return true;
    },
  };
  const server = {
    close(callback) {
      order.push('server:close');
      callback();
    },
  };
  const failures = [];

  const runtime = bindScopeWeaveRuntime({
    server,
    scheduler,
    signalTarget,
    onShutdownFailure: (...args) => failures.push(args),
  });

  assert.deepEqual(order, ['scheduler:start']);
  signalTarget.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(order, ['scheduler:start', 'scheduler:stop', 'server:close']);
  assert.deepEqual(failures, []);
  assert.equal(runtime.shutdown(), false, 'shutdown is idempotent after the first signal');
  signalTarget.emit('SIGINT', 'SIGINT');
  assert.deepEqual(order, ['scheduler:start', 'scheduler:stop', 'server:close']);
});

test('runtime binding exposes only a stable shutdown failure code', () => {
  const signalTarget = new EventEmitter();
  const failures = [];
  const runtime = bindScopeWeaveRuntime({
    server: {
      close(callback) {
        callback(new Error('socket path /secret/internal.sock failed'));
      },
    },
    scheduler: { start: () => true, stop: () => true },
    signalTarget,
    onShutdownFailure: (...args) => failures.push(args),
  });

  assert.equal(runtime.shutdown(), true);
  assert.deepEqual(failures, [['scopeweave_server_shutdown_failed']]);
});
