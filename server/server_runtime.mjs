import process from 'node:process';

function reportShutdownFailure(onShutdownFailure, code) {
  try {
    onShutdownFailure(code);
  } catch {
    // Shutdown must continue even when the operational telemetry sink is unavailable.
  }
}

/**
 * Bind one HTTP server and one background scheduler to process termination semantics.
 *
 * The scheduler is stopped before the HTTP listener closes so a terminating process
 * cannot schedule new provider work. Signal listeners are removed before closing the
 * server, making repeated SIGINT/SIGTERM delivery and direct `shutdown()` calls
 * idempotent. Only stable failure codes are exposed to the operational sink.
 *
 * @param {object} input runtime resources
 * @param {{close:(callback:(error?:Error)=>void)=>void}} input.server active HTTP server
 * @param {{start:()=>boolean,stop:()=>boolean}} input.scheduler reconciliation scheduler
 * @param {object} [input.signalTarget=process] EventEmitter-like process signal target
 * @param {(code:string)=>void} [input.onShutdownFailure] bounded failure sink
 * @returns {Readonly<{shutdown:()=>boolean}>} idempotent shutdown control
 */
export function bindScopeWeaveRuntime({
  server,
  scheduler,
  signalTarget = process,
  onShutdownFailure = () => {},
} = {}) {
  if (!server || typeof server.close !== 'function') {
    throw new TypeError('server must provide close()');
  }
  if (!scheduler || typeof scheduler.start !== 'function' || typeof scheduler.stop !== 'function') {
    throw new TypeError('scheduler must provide start()/stop()');
  }
  if (!signalTarget
    || typeof signalTarget.once !== 'function'
    || typeof signalTarget.off !== 'function') {
    throw new TypeError('signalTarget must provide once()/off()');
  }
  if (typeof onShutdownFailure !== 'function') {
    throw new TypeError('onShutdownFailure must be a function');
  }

  let shuttingDown = false;

  function detachSignals() {
    signalTarget.off('SIGINT', handleSignal);
    signalTarget.off('SIGTERM', handleSignal);
  }

  function shutdown() {
    if (shuttingDown) return false;
    shuttingDown = true;
    detachSignals();

    try {
      scheduler.stop();
    } catch {
      reportShutdownFailure(onShutdownFailure, 'scopeweave_scheduler_shutdown_failed');
    }

    try {
      server.close((error) => {
        if (error) {
          reportShutdownFailure(onShutdownFailure, 'scopeweave_server_shutdown_failed');
        }
      });
    } catch {
      reportShutdownFailure(onShutdownFailure, 'scopeweave_server_shutdown_failed');
    }
    return true;
  }

  function handleSignal() {
    shutdown();
  }

  signalTarget.once('SIGINT', handleSignal);
  signalTarget.once('SIGTERM', handleSignal);
  try {
    scheduler.start();
  } catch (error) {
    detachSignals();
    shuttingDown = true;
    throw error;
  }

  return Object.freeze({ shutdown });
}
