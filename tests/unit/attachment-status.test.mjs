import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_STATUS_DEFAULT_BUDGET_MS,
  ATTACHMENT_STATUS_DEFAULT_CONCURRENCY,
  ATTACHMENT_STATUS_DEFAULT_TIMEOUT_MS,
  ATTACHMENT_STATUS_MAX_BUDGET_MS,
  ATTACHMENT_STATUS_MAX_CONCURRENCY,
  ATTACHMENT_STATUS_MAX_TIMEOUT_MS,
  normalizeAttachmentStatusBudgetMs,
  normalizeAttachmentStatusConcurrency,
  normalizeAttachmentStatusTimeoutMs,
  refreshAttachmentStatuses,
} from '../../server/attachment_status.mjs';

test('attachment status configuration is bounded and fail-safe', () => {
  assert.equal(
    normalizeAttachmentStatusConcurrency(undefined),
    ATTACHMENT_STATUS_DEFAULT_CONCURRENCY,
  );
  assert.equal(normalizeAttachmentStatusConcurrency('4'), 4);
  assert.equal(
    normalizeAttachmentStatusConcurrency(0),
    ATTACHMENT_STATUS_DEFAULT_CONCURRENCY,
  );
  assert.equal(
    normalizeAttachmentStatusConcurrency(1.5),
    ATTACHMENT_STATUS_DEFAULT_CONCURRENCY,
  );
  assert.equal(
    normalizeAttachmentStatusConcurrency(999),
    ATTACHMENT_STATUS_MAX_CONCURRENCY,
  );

  assert.equal(
    normalizeAttachmentStatusTimeoutMs(undefined),
    ATTACHMENT_STATUS_DEFAULT_TIMEOUT_MS,
  );
  assert.equal(normalizeAttachmentStatusTimeoutMs('25'), 25);
  assert.equal(
    normalizeAttachmentStatusTimeoutMs(-1),
    ATTACHMENT_STATUS_DEFAULT_TIMEOUT_MS,
  );
  assert.equal(
    normalizeAttachmentStatusTimeoutMs(50_000),
    ATTACHMENT_STATUS_MAX_TIMEOUT_MS,
  );

  assert.equal(
    normalizeAttachmentStatusBudgetMs(undefined),
    ATTACHMENT_STATUS_DEFAULT_BUDGET_MS,
  );
  assert.equal(normalizeAttachmentStatusBudgetMs('2500'), 2_500);
  assert.equal(
    normalizeAttachmentStatusBudgetMs(0),
    ATTACHMENT_STATUS_DEFAULT_BUDGET_MS,
  );
  assert.equal(
    normalizeAttachmentStatusBudgetMs(100_000),
    ATTACHMENT_STATUS_MAX_BUDGET_MS,
  );
});

test('refresh validates its dependency, diagnostic, and clock contracts', async () => {
  const dependencies = {
    jobStatus: async () => 'PENDING',
    updateStatus() {},
  };
  await assert.rejects(
    () => refreshAttachmentStatuses(null, {}),
    /rows must be an array/,
  );
  await assert.rejects(
    () => refreshAttachmentStatuses([], undefined),
    /jobStatus must be a function/,
  );
  await assert.rejects(
    () => refreshAttachmentStatuses([], { updateStatus() {} }),
    /jobStatus must be a function/,
  );
  await assert.rejects(
    () => refreshAttachmentStatuses([], { jobStatus() {} }),
    /updateStatus must be a function/,
  );
  await assert.rejects(
    () => refreshAttachmentStatuses([], { ...dependencies, onError: 'log' }),
    /onError must be a function/,
  );
  await assert.rejects(
    () => refreshAttachmentStatuses([], { ...dependencies, now: 1 }),
    /now must be a function/,
  );
  await assert.rejects(
    () => refreshAttachmentStatuses([], { ...dependencies, now: () => Number.NaN }),
    /clock must return a finite number/,
  );
});

test('empty and settled rows perform no downstream work', async () => {
  const dependencies = {
    jobStatus: async () => { throw new Error('must not run'); },
    updateStatus: () => { throw new Error('must not run'); },
  };
  assert.deepEqual(await refreshAttachmentStatuses([], dependencies), {
    attempted: 0,
    changed: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
  });

  const metrics = {};
  assert.deepEqual(
    await refreshAttachmentStatuses(
      [null, { id: 1, status: 'SUCCEEDED', jobId: 'job-1' }],
      { ...dependencies, metrics },
    ),
    { attempted: 0, changed: 0, failed: 0, skipped: 0, deferred: 0 },
  );
  assert.deepEqual(metrics, {
    attachmentStatusRefreshAttempted: 0,
    attachmentStatusRefreshChanged: 0,
    attachmentStatusRefreshFailed: 0,
    attachmentStatusRefreshSkipped: 0,
    attachmentStatusRefreshDeferred: 0,
  });
});

test('100 pending rows reach but never exceed configured concurrency', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    jobId: `job-${index + 1}`,
    status: index % 3 === 0 ? 'RUNNING' : 'PENDING',
  }));
  let active = 0;
  let peak = 0;
  let started = 0;
  let releaseInitialWorkers;
  const initialWorkerGate = new Promise((resolve) => {
    releaseInitialWorkers = resolve;
  });
  const updates = [];
  const metrics = {
    attachmentStatusRefreshAttempted: 10,
    attachmentStatusRefreshChanged: 20,
    attachmentStatusRefreshFailed: 30,
    attachmentStatusRefreshSkipped: 35,
    attachmentStatusRefreshDeferred: 40,
  };

  const counts = await refreshAttachmentStatuses(rows, {
    orgId: 7,
    userId: 9,
    concurrency: 8,
    timeoutMs: 1_000,
    budgetMs: 10_000,
    metrics,
    jobStatus: async (orgId, userId, jobId, { signal }) => {
      assert.equal(orgId, 7);
      assert.equal(userId, 9);
      assert.equal(signal.aborted, false);
      active += 1;
      started += 1;
      peak = Math.max(peak, active);
      if (started === 8) releaseInitialWorkers();
      await initialWorkerGate;
      active -= 1;
      const rowNumber = Number(jobId.split('-')[1]);
      return rowNumber % 2 === 0 ? 'SUCCEEDED' : rows[rowNumber - 1].status;
    },
    updateStatus: async (status, attachmentId) => {
      updates.push([status, attachmentId]);
    },
  });

  assert.equal(peak, 8, `peak concurrency ${peak} did not match configured limit`);
  assert.deepEqual(counts, {
    attempted: 100,
    changed: 50,
    failed: 0,
    skipped: 0,
    deferred: 0,
  });
  assert.equal(updates.length, 50);
  assert.deepEqual(metrics, {
    attachmentStatusRefreshAttempted: 110,
    attachmentStatusRefreshChanged: 70,
    attachmentStatusRefreshFailed: 30,
    attachmentStatusRefreshSkipped: 35,
    attachmentStatusRefreshDeferred: 40,
  });
});

test('request-wide deadline defers work that has not started', async () => {
  const rows = [
    { id: 1, jobId: 'job-1', status: 'PENDING' },
    { id: 2, jobId: 'job-2', status: 'PENDING' },
    { id: 3, jobId: 'job-3', status: 'PENDING' },
  ];
  const clockValues = [0, 0, 20, 30];
  const counts = await refreshAttachmentStatuses(rows, {
    concurrency: 1,
    timeoutMs: 1_000,
    budgetMs: 15,
    now: () => clockValues.shift() ?? 30,
    jobStatus: async () => 'PENDING',
    updateStatus: () => { throw new Error('unchanged status must not be written'); },
  });

  assert.deepEqual(counts, {
    attempted: 1,
    changed: 0,
    failed: 0,
    skipped: 0,
    deferred: 2,
  });
  assert.deepEqual(rows.map((row) => row.status), ['PENDING', 'PENDING', 'PENDING']);
});

test('invalid identifiers and categorized failures preserve stale state', async () => {
  const rows = [
    { id: 1, jobId: null, status: 'PENDING' },
    { id: 2, jobId: '', status: 'RUNNING' },
    { id: 3, jobId: '   ', status: 'PENDING' },
    { id: 4, jobId: 'throws', status: 'PENDING' },
    { id: 5, jobId: 'invalid-status', status: 'PENDING' },
    { id: 6, jobId: 'write-fails', status: 'PENDING' },
    { id: 7, jobId: 'times-out', status: 'PENDING' },
  ];
  let aborted = false;
  const categories = [];
  const counts = await refreshAttachmentStatuses(rows, {
    concurrency: 3,
    timeoutMs: 5,
    budgetMs: 1_000,
    onError: ({ category }) => categories.push(category),
    jobStatus: async (_orgId, _userId, jobId, { signal }) => {
      if (jobId === 'throws') throw new Error('downstream failure with sensitive detail');
      if (jobId === 'invalid-status') return 'UNKNOWN';
      if (jobId === 'write-fails') return 'SUCCEEDED';
      return new Promise(() => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      });
    },
    updateStatus: (_status, attachmentId) => {
      if (attachmentId === 6) throw new Error('write failure');
    },
  });

  assert.equal(aborted, true);
  assert.deepEqual(counts, {
    attempted: 4,
    changed: 0,
    failed: 4,
    skipped: 3,
    deferred: 0,
  });
  assert.deepEqual(
    categories.sort(),
    ['downstream_lookup', 'invalid_status', 'status_persistence', 'timeout'].sort(),
  );
  assert.equal(categories.some((category) => category.includes('sensitive')), false);
  assert.equal(rows[5].status, 'PENDING');
  assert.equal(rows[6].status, 'PENDING');
});

test('diagnostic sink failures and omitted diagnostics stay isolated', async () => {
  const row = [{ id: 1, jobId: 'job-1', status: 'PENDING' }];
  const dependencies = {
    timeoutMs: 100,
    budgetMs: 1_000,
    jobStatus: async () => { throw new Error('downstream failure'); },
    updateStatus() {},
  };

  assert.deepEqual(await refreshAttachmentStatuses(row, dependencies), {
    attempted: 1,
    changed: 0,
    failed: 1,
    skipped: 0,
    deferred: 0,
  });
  assert.deepEqual(
    await refreshAttachmentStatuses(row, {
      ...dependencies,
      onError: () => { throw new Error('logger unavailable'); },
    }),
    { attempted: 1, changed: 0, failed: 1, skipped: 0, deferred: 0 },
  );
});
