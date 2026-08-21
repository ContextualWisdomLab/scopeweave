const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 60_000;
const CANONICAL_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

/** Stable fail-closed error for Stripe reconciliation scheduler configuration. */
export class StripeReconciliationSchedulerError extends Error {
  /**
   * Create one sanitized scheduler failure.
   * @param {string} code stable machine-readable failure code
   */
  constructor(code) {
    super(code);
    this.name = 'StripeReconciliationSchedulerError';
    this.code = code;
  }
}

function schedulerError(code) {
  return new StripeReconciliationSchedulerError(code);
}

function reportFailure(onFailure, code) {
  try {
    onFailure(code);
  } catch {
    // A broken telemetry sink must never multiply or terminate the reconciliation loop.
  }
}

/**
 * Parse the operator-owned Stripe reconciliation poll interval.
 *
 * Only a canonical base-10 millisecond integer is accepted. The lower bound prevents
 * a configuration typo from creating a provider hot loop; the upper bound keeps a
 * healthy worker from leaving verified billing events unattended for more than one
 * minute between passes.
 *
 * @param {string|number|undefined} value configured interval in milliseconds
 * @returns {number} validated interval between 250 ms and 60 seconds
 */
export function stripeReconciliationPollIntervalMs(value) {
  if (value === undefined) return DEFAULT_POLL_INTERVAL_MS;
  if (
    (typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'string' && !CANONICAL_INTEGER_PATTERN.test(value))
  ) {
    throw schedulerError('stripe_reconciliation_scheduler_interval_invalid');
  }
  const intervalMs = Number(value);
  if (
    !Number.isSafeInteger(intervalMs)
    || intervalMs < MIN_POLL_INTERVAL_MS
    || intervalMs > MAX_POLL_INTERVAL_MS
  ) {
    throw schedulerError('stripe_reconciliation_scheduler_interval_invalid');
  }
  return intervalMs;
}

/**
 * Create a single-flight scheduler for durable Stripe reconciliation work.
 *
 * The scheduler arms its next timer only after the current reconciliation promise has
 * settled, so provider latency can never create overlapping poll iterations. Runtime
 * failures are collapsed to a stable non-secret code and polling continues. `stop()`
 * flips the running state before cancelling a waiting timer, which also prevents an
 * already in-flight iteration from resurrecting the loop during graceful shutdown.
 *
 * @param {object} input scheduler ports and configuration
 * @param {() => Promise<unknown>|unknown} input.runOnce consume at most one durable job
 * @param {number} [input.intervalMs=1000] validated delay between completed passes
 * @param {(callback:Function,delayMs:number)=>unknown} [input.schedule=setTimeout] timer arm
 * @param {(timer:unknown)=>void} [input.cancel=clearTimeout] timer cancellation
 * @param {(code:string)=>void} [input.onFailure] bounded operational failure sink
 * @returns {Readonly<{start:()=>boolean,stop:()=>boolean}>} scheduler lifecycle controls
 */
export function createStripeReconciliationScheduler({
  runOnce,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
  onFailure = () => {},
} = {}) {
  if (typeof runOnce !== 'function') throw new TypeError('runOnce must be a function');
  if (typeof schedule !== 'function') throw new TypeError('schedule must be a function');
  if (typeof cancel !== 'function') throw new TypeError('cancel must be a function');
  if (typeof onFailure !== 'function') throw new TypeError('onFailure must be a function');
  const delayMs = stripeReconciliationPollIntervalMs(intervalMs);

  let running = false;
  let timer = null;

  function arm(delay) {
    try {
      timer = schedule(tick, delay);
    } catch {
      timer = null;
      running = false;
      throw schedulerError('stripe_reconciliation_scheduler_timer_failed');
    }
  }

  async function tick() {
    timer = null;
    if (!running) return;
    try {
      await runOnce();
    } catch {
      reportFailure(onFailure, 'stripe_reconciliation_scheduler_iteration_failed');
    }
    if (!running) return;
    try {
      arm(delayMs);
    } catch {
      reportFailure(onFailure, 'stripe_reconciliation_scheduler_timer_failed');
    }
  }

  return Object.freeze({
    /** Start one immediate asynchronous pass. Repeated starts are side-effect free. */
    start() {
      if (running) return false;
      running = true;
      arm(0);
      return true;
    },

    /** Stop future passes. An in-flight pass may finish but cannot schedule another. */
    stop() {
      if (!running) return false;
      running = false;
      const pendingTimer = timer;
      timer = null;
      if (pendingTimer !== null) {
        try {
          cancel(pendingTimer);
        } catch {
          reportFailure(onFailure, 'stripe_reconciliation_scheduler_timer_cancel_failed');
        }
      }
      return true;
    },
  });
}
