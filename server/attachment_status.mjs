/** Default maximum concurrent Clearfolio status lookups. */
export const ATTACHMENT_STATUS_DEFAULT_CONCURRENCY = 8;

/** Conservative hard ceiling for operator-configured lookup concurrency. */
export const ATTACHMENT_STATUS_MAX_CONCURRENCY = 32;

/** Default downstream status lookup timeout in milliseconds. */
export const ATTACHMENT_STATUS_DEFAULT_TIMEOUT_MS = 3_000;

/** Hard ceiling for a downstream status lookup timeout in milliseconds. */
export const ATTACHMENT_STATUS_MAX_TIMEOUT_MS = 30_000;

/** Default wall-clock budget for one attachment-list refresh pass. */
export const ATTACHMENT_STATUS_DEFAULT_BUDGET_MS = 5_000;

/** Hard ceiling for one attachment-list refresh pass. */
export const ATTACHMENT_STATUS_MAX_BUDGET_MS = 60_000;

/** Status values accepted from the Clearfolio conversion contract. */
const ATTACHMENT_STATUS_VALUES = new Set(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']);

/** Timeout error name used only for sanitized failure categorization. */
const ATTACHMENT_STATUS_TIMEOUT_ERROR = 'AttachmentStatusTimeoutError';

/** Fixed low-cardinality failure categories safe for operational metrics. */
const ATTACHMENT_STATUS_FAILURE_METRICS = Object.freeze({
  timeout: 'attachmentStatusRefreshTimeoutFailures',
  downstream_lookup: 'attachmentStatusRefreshDownstreamLookupFailures',
  invalid_status: 'attachmentStatusRefreshInvalidStatusFailures',
  status_persistence: 'attachmentStatusRefreshPersistenceFailures',
});

/**
 * Normalize a positive integer while applying a conservative upper bound.
 *
 * @param {unknown} value - Untrusted environment or caller value.
 * @param {number} fallback - Value used for missing or invalid input.
 * @param {number} maximum - Largest accepted value.
 * @returns {number} A safe positive integer no greater than `maximum`.
 */
function normalizeBoundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

/**
 * Normalize the configured attachment-status worker count.
 *
 * @param {unknown} value - Environment or caller supplied value.
 * @returns {number} An integer between 1 and 32, defaulting to 8.
 */
export function normalizeAttachmentStatusConcurrency(value) {
  return normalizeBoundedInteger(
    value,
    ATTACHMENT_STATUS_DEFAULT_CONCURRENCY,
    ATTACHMENT_STATUS_MAX_CONCURRENCY,
  );
}

/**
 * Normalize the configured Clearfolio status timeout.
 *
 * @param {unknown} value - Environment or caller supplied value.
 * @returns {number} A positive timeout no greater than 30 seconds.
 */
export function normalizeAttachmentStatusTimeoutMs(value) {
  return normalizeBoundedInteger(
    value,
    ATTACHMENT_STATUS_DEFAULT_TIMEOUT_MS,
    ATTACHMENT_STATUS_MAX_TIMEOUT_MS,
  );
}

/**
 * Normalize the request-wide attachment refresh budget.
 *
 * @param {unknown} value - Environment or caller supplied value.
 * @returns {number} A positive budget no greater than 60 seconds.
 */
export function normalizeAttachmentStatusBudgetMs(value) {
  return normalizeBoundedInteger(
    value,
    ATTACHMENT_STATUS_DEFAULT_BUDGET_MS,
    ATTACHMENT_STATUS_MAX_BUDGET_MS,
  );
}

/**
 * Read a clock dependency and reject unusable values before deadline math.
 *
 * @param {() => number} clock - Clock returning epoch-like milliseconds.
 * @returns {number} A finite millisecond value.
 * @throws {TypeError} If the clock returns a non-finite value.
 */
function readClock(clock) {
  const value = clock();
  if (!Number.isFinite(value)) throw new TypeError('clock must return a finite number');
  return value;
}

/**
 * Add one refresh result to process-level operational counters.
 *
 * Aggregate counters preserve the public refresh result contract. Fixed
 * category counters provide operator diagnostics without job identifiers,
 * downstream text, URLs, or other high-cardinality labels.
 *
 * @param {object|undefined} metrics - Mutable process metric registry.
 * @param {{attempted:number,changed:number,failed:number,skipped:number,deferred:number}} counts - Refresh result.
 * @param {Record<string,number>} failureCounts - Sanitized fixed-category failures.
 * @returns {void}
 */
function addRefreshMetrics(metrics, counts, failureCounts) {
  if (!metrics) return;
  const fields = {
    attachmentStatusRefreshAttempted: 'attempted',
    attachmentStatusRefreshChanged: 'changed',
    attachmentStatusRefreshFailed: 'failed',
    attachmentStatusRefreshSkipped: 'skipped',
    attachmentStatusRefreshDeferred: 'deferred',
  };
  for (const [metric, count] of Object.entries(fields)) {
    metrics[metric] = (Number(metrics[metric]) || 0) + counts[count];
  }
  for (const [category, metric] of Object.entries(ATTACHMENT_STATUS_FAILURE_METRICS)) {
    metrics[metric] = (Number(metrics[metric]) || 0) + failureCounts[category];
  }
}

/**
 * Publish a sanitized refresh-failure category without risking the request.
 *
 * The callback never receives a Clearfolio job identifier, URL, response body,
 * or raw downstream error. A failing diagnostic sink is isolated because
 * observability must not break attachment listing.
 *
 * @param {((event:{category:string}) => unknown)|undefined} onError - Optional diagnostic sink.
 * @param {string} category - Fixed safe failure category.
 * @returns {void}
 */
function reportRefreshFailure(onError, category) {
  if (!onError) return;
  try {
    onError({ category });
  } catch {
    // Diagnostics are best effort and must never fail the list response.
  }
}

/**
 * Await one downstream lookup with an AbortSignal and a hard caller-side timeout.
 *
 * The explicit race means a non-compliant downstream adapter cannot hold a list
 * response open forever even if it ignores the supplied AbortSignal.
 *
 * @param {() => Promise<string>} lookup - Deferred downstream lookup.
 * @param {AbortController} controller - Controller whose signal is passed downstream.
 * @param {number} timeoutMs - Hard timeout in milliseconds.
 * @returns {Promise<string>} The downstream status.
 */
async function withTimeout(lookup, controller, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('attachment status lookup timed out');
      error.name = ATTACHMENT_STATUS_TIMEOUT_ERROR;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([lookup(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh pending attachment statuses through a bounded worker pool.
 *
 * Rows are updated in place so the caller can serialize the refreshed public
 * representation. A shared wall-clock deadline bounds the whole refresh pass;
 * workers clamp each lookup timeout to the remaining request budget and mark
 * unstarted rows as deferred after the deadline. Rows with missing conversion
 * identifiers are counted as skipped data-quality cases. Downstream,
 * validation, or persistence failures preserve stale status and never fail the
 * attachment-list response.
 *
 * @param {Array<object>} rows - Attachment rows containing `id`, `status`, and `jobId`.
 * @param {object} options - Downstream functions, tenant identifiers, limits, and metrics.
 * @param {number|string} options.orgId - ScopeWeave organization identifier.
 * @param {number|string} options.userId - Requesting user identifier.
 * @param {(orgId: unknown, userId: unknown, jobId: string, options: {signal: AbortSignal}) => Promise<string>} options.jobStatus - Downstream lookup.
 * @param {(status: string, attachmentId: unknown) => unknown|Promise<unknown>} options.updateStatus - Changed-only persistence callback.
 * @param {unknown} [options.concurrency] - Maximum concurrent lookups.
 * @param {unknown} [options.timeoutMs] - Per-lookup timeout in milliseconds.
 * @param {unknown} [options.budgetMs] - Request-wide refresh budget in milliseconds.
 * @param {object} [options.metrics] - Mutable process metrics object.
 * @param {(event:{category:string}) => unknown} [options.onError] - Sanitized diagnostic callback.
 * @param {() => number} [options.now] - Injectable finite millisecond clock for deterministic tests.
 * @returns {Promise<{attempted:number,changed:number,failed:number,skipped:number,deferred:number}>} Structured counters.
 */
export async function refreshAttachmentStatuses(rows, options) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (typeof options?.jobStatus !== 'function') throw new TypeError('jobStatus must be a function');
  if (typeof options?.updateStatus !== 'function') throw new TypeError('updateStatus must be a function');
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }

  const counts = { attempted: 0, changed: 0, failed: 0, skipped: 0, deferred: 0 };
  const failureCounts = Object.fromEntries(
    Object.keys(ATTACHMENT_STATUS_FAILURE_METRICS).map((category) => [category, 0]),
  );
  const pending = rows.filter((row) => row?.status === 'PENDING' || row?.status === 'RUNNING');
  const concurrency = normalizeAttachmentStatusConcurrency(options.concurrency);
  const timeoutMs = normalizeAttachmentStatusTimeoutMs(options.timeoutMs);
  const budgetMs = normalizeAttachmentStatusBudgetMs(options.budgetMs);
  const clock = options.now || Date.now;
  const deadline = readClock(clock) + budgetMs;
  let cursor = 0;

  /**
   * Process pending rows until the shared cursor is exhausted.
   *
   * JavaScript advances the cursor synchronously before each await, so workers
   * claim distinct rows without locks and context switching stays bounded by the
   * configured worker count.
   *
   * @returns {Promise<void>} Resolves after this worker has no remaining row.
   */
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      const row = pending[index];
      const remainingBudgetMs = deadline - readClock(clock);
      if (remainingBudgetMs <= 0) {
        counts.deferred += 1;
        continue;
      }

      const jobId = typeof row.jobId === 'string' ? row.jobId.trim() : '';
      if (!jobId) {
        counts.skipped += 1;
        continue;
      }

      counts.attempted += 1;
      const controller = new AbortController();
      let failureCategory = 'downstream_lookup';
      try {
        const effectiveTimeoutMs = Math.max(
          1,
          Math.min(timeoutMs, Math.ceil(remainingBudgetMs)),
        );
        const nextStatus = await withTimeout(
          () => options.jobStatus(
            options.orgId,
            options.userId,
            jobId,
            { signal: controller.signal },
          ),
          controller,
          effectiveTimeoutMs,
        );
        failureCategory = 'invalid_status';
        if (!ATTACHMENT_STATUS_VALUES.has(nextStatus)) {
          throw new Error('invalid downstream status');
        }
        if (nextStatus !== row.status) {
          failureCategory = 'status_persistence';
          await options.updateStatus(nextStatus, row.id);
          row.status = nextStatus;
          counts.changed += 1;
        }
      } catch (error) {
        counts.failed += 1;
        const category = error?.name === ATTACHMENT_STATUS_TIMEOUT_ERROR
          ? 'timeout'
          : failureCategory;
        failureCounts[category] += 1;
        reportRefreshFailure(options.onError, category);
      }
    }
  }

  const workerCount = Math.min(concurrency, pending.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  addRefreshMetrics(options.metrics, counts, failureCounts);
  return counts;
}
