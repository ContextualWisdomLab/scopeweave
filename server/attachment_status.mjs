/** Default maximum concurrent Clearfolio status lookups. */
export const ATTACHMENT_STATUS_DEFAULT_CONCURRENCY = 8;

/** Conservative hard ceiling for operator-configured lookup concurrency. */
export const ATTACHMENT_STATUS_MAX_CONCURRENCY = 32;

/** Default downstream status lookup timeout in milliseconds. */
export const ATTACHMENT_STATUS_DEFAULT_TIMEOUT_MS = 3_000;

/** Hard ceiling for a downstream status lookup timeout in milliseconds. */
export const ATTACHMENT_STATUS_MAX_TIMEOUT_MS = 30_000;

/** Status values accepted from the Clearfolio conversion contract. */
const ATTACHMENT_STATUS_VALUES = new Set(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']);

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
 * Add one refresh result to process-level operational counters.
 *
 * @param {object|undefined} metrics - Mutable process metric registry.
 * @param {{attempted:number,changed:number,failed:number,deferred:number}} counts - Refresh result.
 * @returns {void}
 */
function addRefreshMetrics(metrics, counts) {
  if (!metrics) return;
  const fields = {
    attachmentStatusRefreshAttempted: 'attempted',
    attachmentStatusRefreshChanged: 'changed',
    attachmentStatusRefreshFailed: 'failed',
    attachmentStatusRefreshDeferred: 'deferred',
  };
  for (const [metric, count] of Object.entries(fields)) {
    metrics[metric] = (Number(metrics[metric]) || 0) + counts[count];
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
      reject(new Error('attachment status lookup timed out'));
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
 * representation. Missing job identifiers and downstream or persistence
 * failures preserve stale status and never fail the attachment-list response.
 *
 * @param {Array<object>} rows - Attachment rows containing `id`, `status`, and `jobId`.
 * @param {object} options - Downstream functions, tenant identifiers, limits, and metrics.
 * @param {number|string} options.orgId - ScopeWeave organization identifier.
 * @param {number|string} options.userId - Requesting user identifier.
 * @param {(orgId: unknown, userId: unknown, jobId: string, options: {signal: AbortSignal}) => Promise<string>} options.jobStatus - Downstream lookup.
 * @param {(status: string, attachmentId: unknown) => unknown|Promise<unknown>} options.updateStatus - Changed-only persistence callback.
 * @param {unknown} [options.concurrency] - Maximum concurrent lookups.
 * @param {unknown} [options.timeoutMs] - Per-lookup timeout in milliseconds.
 * @param {object} [options.metrics] - Mutable process metrics object.
 * @returns {Promise<{attempted:number,changed:number,failed:number,deferred:number}>} Structured counters.
 */
export async function refreshAttachmentStatuses(rows, options) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (typeof options?.jobStatus !== 'function') throw new TypeError('jobStatus must be a function');
  if (typeof options?.updateStatus !== 'function') throw new TypeError('updateStatus must be a function');

  const counts = { attempted: 0, changed: 0, failed: 0, deferred: 0 };
  const pending = rows.filter((row) => row?.status === 'PENDING' || row?.status === 'RUNNING');
  const concurrency = normalizeAttachmentStatusConcurrency(options.concurrency);
  const timeoutMs = normalizeAttachmentStatusTimeoutMs(options.timeoutMs);
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
      const jobId = typeof row.jobId === 'string' ? row.jobId.trim() : '';
      if (!jobId) {
        counts.deferred += 1;
        continue;
      }

      counts.attempted += 1;
      const controller = new AbortController();
      try {
        const nextStatus = await withTimeout(
          () => options.jobStatus(
            options.orgId,
            options.userId,
            jobId,
            { signal: controller.signal },
          ),
          controller,
          timeoutMs,
        );
        if (!ATTACHMENT_STATUS_VALUES.has(nextStatus)) {
          throw new Error('invalid downstream status');
        }
        if (nextStatus !== row.status) {
          await options.updateStatus(nextStatus, row.id);
          row.status = nextStatus;
          counts.changed += 1;
        }
      } catch {
        counts.failed += 1;
      }
    }
  }

  const workerCount = Math.min(concurrency, pending.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  addRefreshMetrics(options.metrics, counts);
  return counts;
}
