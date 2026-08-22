import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

await import('./stripe-reconciliation-evidence-export.test.mjs');

import { bindScopeWeaveRuntime } from '../../server/server_runtime.mjs';

test('forced-close failures are sanitized when the graceful shutdown window expires', () => {
  const signalTarget = new EventEmitter();
  const failures = [];
  const watchdogs = [];
  const runtime = bindScopeWeaveRuntime({
    server: {
      close() {
        // Keep one response open so the bounded shutdown watchdog must fire.
      },
      closeAllConnections() {
        throw new Error('socket /secret/runtime.sock must not escape');
      },
    },
    scheduler: { start: () => true, stop: () => true },
    signalTarget,
    onShutdownFailure: (code) => failures.push(code),
    scheduleShutdown(callback, delayMs) {
      watchdogs.push({ callback, delayMs });
      return 1;
    },
    cancelShutdown: () => {},
  });

  assert.equal(runtime.shutdown(), true);
  assert.equal(watchdogs.length, 1);
  assert.equal(watchdogs[0].delayMs, 10_000);
  assert.doesNotThrow(() => watchdogs[0].callback());
  assert.deepEqual(failures, ['scopeweave_server_shutdown_failed']);
});
