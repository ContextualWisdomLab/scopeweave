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
    return { delayMs: entry.delayMs, promise: entry.callback(), callback: entry.callback };
  }

  return { schedule, cancel, runNext, beginNext, pending, cancelled };
}

test('poll interval parsing is bounded and rejects ambiguous configuration', () => {
  assert.equal(stripeReconciliationPollIntervalMs(undefined), 1_000);
  assert.equal(stripeReconciliationPollIntervalMs(250), 250);
  assert.equal(stripeReconciliationPollIntervalMs('250'), 250);
  assert.equal(stripeReconciliationPollIntervalMs('60000'), 60_000);

  for (const invalid of [
    '', ' 250', '250 ', '1e3', '0', '99', '60001', '-1', 'NaN', null, {}, 250.5,
  ]) {
    assert.throws(
      () => stripeReconciliationPollIntervalMs(invalid),
      (error) => error?.code === 'stripe_reconciliation_scheduler_interval_invalid',
      `expected ${JSON.stringify(invalid)} to fail closed`,
    );
  }
});

test('scheduler validates lifecycle ports before arming provider work', () => {
  assert.throws(() => createStripeReconciliationScheduler(), /runOnce must be a function/);
  assert.throws(
    () => createStripeReconciliationScheduler({ runOnce: async () => {}, schedule: null }),
    /schedule must be a function/,
  );
  assert.throws(
    () => createStripeReconciliationScheduler({ runOnce: async () => {}, cancel: null }),
    /cancel must be a function/,
  );
  assert.throws(
    () => createStripeReconciliationScheduler({ runOnce: async () => {}, onFailure: null }),
    /onFailure must be a function/,
  );

  const realTimerScheduler = createStripeReconciliationScheduler({ runOnce: async () => {} });
  assert.equal(realTimerScheduler.start(), true);
  assert.equal(realTimerScheduler.stop(), true);
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

test('a stale timer callback observed after stop cannot restart reconciliation', async () => {
  let callback;
  const failures = [];
  const scheduler = createStripeReconciliationScheduler({
    runOnce: async () => {
      throw new Error('must not run after stop');
    },
    intervalMs: 250,
    schedule: (scheduled) => {
      callback = scheduled;
      return 1;
    },
    cancel: () => {},
    onFailure: (code) => failures.push(code),
  });

  scheduler.start();
  scheduler.stop();
  await callback();
  assert.deepEqual(failures, []);
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

test('scheduler fails closed if its timer cannot be armed or re-armed', async () => {
  const startupScheduler = createStripeReconciliationScheduler({
    runOnce: async () => {},
    intervalMs: 250,
    schedule: () => {
      throw new Error('timer allocation failure');
    },
    cancel: () => {},
  });
  assert.throws(
    () => startupScheduler.start(),
    (error) => error?.code === 'stripe_reconciliation_scheduler_timer_failed',
  );
  assert.equal(startupScheduler.stop(), false);

  let callback;
  let armCount = 0;
  const failures = [];
  const retryScheduler = createStripeReconciliationScheduler({
    runOnce: async () => ({ status: 'idle' }),
    intervalMs: 250,
    schedule: (scheduled) => {
      armCount += 1;
      if (armCount > 1) throw new Error('timer re-arm failure');
      callback = scheduled;
      return 1;
    },
    cancel: () => {},
    onFailure: (code) => failures.push(code),
  });
  retryScheduler.start();
  await callback();
  assert.deepEqual(failures, ['stripe_reconciliation_scheduler_timer_failed']);
  assert.equal(retryScheduler.stop(), false, 'timer failure terminates the loop instead of hot-spinning');
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

test('timer cancellation failure is sanitized after the loop is already stopped', () => {
  const failures = [];
  const scheduler = createStripeReconciliationScheduler({
    runOnce: async () => {},
    intervalMs: 250,
    schedule: () => 7,
    cancel: () => {
      throw new Error('secret timer implementation detail');
    },
    onFailure: (code) => failures.push(code),
  });
  scheduler.start();
  assert.equal(scheduler.stop(), true);
  assert.deepEqual(failures, ['stripe_reconciliation_scheduler_timer_cancel_failed']);
  assert.equal(scheduler.stop(), false);
});

test('runtime binding validates server, scheduler, signal, telemetry, and shutdown-timer ports', () => {
  const signalTarget = new EventEmitter();
  const server = { close: () => {} };
  const scheduler = { start: () => true, stop: () => true };

  assert.throws(() => bindScopeWeaveRuntime(), /server must provide close/);
  assert.throws(() => bindScopeWeaveRuntime({ server: {}, scheduler }), /server must provide close/);
  assert.throws(() => bindScopeWeaveRuntime({ server, scheduler: {} }), /scheduler must provide/);
  assert.throws(
    () => bindScopeWeaveRuntime({ server, scheduler: { start: () => true } }),
    /scheduler must provide/,
  );
  assert.throws(
    () => bindScopeWeaveRuntime({ server, scheduler, signalTarget: {} }),
    /signalTarget must provide/,
  );
  assert.throws(
    () => bindScopeWeaveRuntime({
      server,
      scheduler,
      signalTarget: { once: () => {} },
    }),
    /signalTarget must provide/,
  );
  assert.throws(
    () => bindScopeWeaveRuntime({ server, scheduler, signalTarget, onShutdownFailure: null }),
    /onShutdownFailure must be a function/,
  );
  assert.throws(
    () => bindScopeWeaveRuntime({ server, scheduler, signalTarget, scheduleShutdown: null }),
    /scheduleShutdown must be a function/,
  );
  assert.throws(
    () => bindScopeWeaveRuntime({ server, scheduler, signalTarget, cancelShutdown: null }),
    /cancelShutdown must be a function/,
  );
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

test('runtime force-closes long-lived connections after the bounded graceful drain window', async () => {
  const shutdownTimers = createFakeTimers();
  const order = [];
  const signalTarget = new EventEmitter();
  let closeCallback;
  const server = {
    close(callback) {
      order.push('server:close');
      closeCallback = callback;
    },
    closeAllConnections() {
      order.push('server:force-close');
    },
  };
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
  const failures = [];

  const runtime = bindScopeWeaveRuntime({
    server,
    scheduler,
    signalTarget,
    onShutdownFailure: (code) => failures.push(code),
    scheduleShutdown: shutdownTimers.schedule,
    cancelShutdown: shutdownTimers.cancel,
  });

  assert.equal(runtime.shutdown(), true);
  assert.deepEqual(order, ['scheduler:start', 'scheduler:stop', 'server:close']);
  assert.equal(shutdownTimers.pending.size, 1, 'active responses need one bounded shutdown watchdog');
  assert.equal(await shutdownTimers.runNext(), 10_000);
  assert.deepEqual(order, ['scheduler:start', 'scheduler:stop', 'server:close', 'server:force-close']);
  closeCallback();
  assert.deepEqual(failures, []);
});

test('runtime cancels the forced-close watchdog when graceful drain completes first', () => {
  const shutdownTimers = createFakeTimers();
  const signalTarget = new EventEmitter();
  let closeCallback;
  let forceCloseCalls = 0;
  const runtime = bindScopeWeaveRuntime({
    server: {
      close(callback) {
        closeCallback = callback;
      },
      closeAllConnections() {
        forceCloseCalls += 1;
      },
    },
    scheduler: { start: () => true, stop: () => true },
    signalTarget,
    scheduleShutdown: shutdownTimers.schedule,
    cancelShutdown: shutdownTimers.cancel,
  });

  assert.equal(runtime.shutdown(), true);
  const watchdogId = [...shutdownTimers.pending.keys()][0];
  assert.ok(watchdogId, 'graceful shutdown must arm one bounded watchdog');
  closeCallback();
  assert.deepEqual(shutdownTimers.cancelled, [watchdogId]);
  assert.equal(shutdownTimers.pending.size, 0);
  assert.equal(forceCloseCalls, 0, 'clean drain must not terminate already-finished connections');
});

test('runtime binding exposes only stable scheduler and server shutdown failure codes', () => {
  const signalTarget = new EventEmitter();
  const failures = [];
  const runtime = bindScopeWeaveRuntime({
    server: {
      close(callback) {
        callback(new Error('socket path /secret/internal.sock failed'));
      },
    },
    scheduler: {
      start: () => true,
      stop() {
        throw new Error('provider state must not escape');
      },
    },
    signalTarget,
    onShutdownFailure: (...args) => failures.push(args),
  });

  assert.equal(runtime.shutdown(), true);
  assert.deepEqual(failures, [
    ['scopeweave_scheduler_shutdown_failed'],
    ['scopeweave_server_shutdown_failed'],
  ]);
});

test('runtime shutdown survives thrown close and broken failure telemetry', () => {
  const signalTarget = new EventEmitter();
  const runtime = bindScopeWeaveRuntime({
    server: {
      close() {
        throw new Error('sensitive close failure');
      },
    },
    scheduler: { start: () => true, stop: () => true },
    signalTarget,
    onShutdownFailure: () => {
      throw new Error('telemetry unavailable');
    },
  });

  assert.equal(runtime.shutdown(), true);
});

test('runtime detaches termination handlers when scheduler startup fails', () => {
  const signalTarget = new EventEmitter();
  const startupError = new Error('scheduler failed to start');
  assert.throws(
    () => bindScopeWeaveRuntime({
      server: { close: () => {} },
      scheduler: {
        start() {
          throw startupError;
        },
        stop: () => true,
      },
      signalTarget,
    }),
    (error) => error === startupError,
  );
  assert.equal(signalTarget.listenerCount('SIGINT'), 0);
  assert.equal(signalTarget.listenerCount('SIGTERM'), 0);
});

test('runtime defaults can bind and immediately unbind the real process signal target', () => {
  const runtime = bindScopeWeaveRuntime({
    server: { close: (callback) => callback() },
    scheduler: { start: () => true, stop: () => true },
  });
  assert.equal(runtime.shutdown(), true);
});