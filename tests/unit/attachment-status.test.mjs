import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_STATUS_DEFAULT_CONCURRENCY,
  ATTACHMENT_STATUS_DEFAULT_TIMEOUT_MS,
  ATTACHMENT_STATUS_MAX_CONCURRENCY,
  ATTACHMENT_STATUS_MAX_TIMEOUT_MS,
  normalizeAttachmentStatusConcurrency,
  normalizeAttachmentStatusTimeoutMs,
  refreshAttachmentStatuses,
} from '../../server/attachment_status.mjs';

test('attachment status configuration is bounded and fail-safe', () => {
  assert.equal(normalizeAttachmentStatusConcurrency(undefined), ATTACHMENT_STATUS_DEFAULT_CONCURRENCY);
  assert.equal(normalizeAttachmentStatusConcurrency('4'), 4);
  assert.equal(normalizeAttachmentStatusConcurrency(0), ATTACHMENT_STATUS_DEFAULT_CONCURRENCY);
  assert.equal(normalizeAttachmentStatusConcurrency(1.5), ATTACHMENT_STATUS_DEFAULT_CONCURRENCY);
  assert.equal(normalizeAttachmentStatusConcurrency(999), ATTACHMENT_STATUS_MAX_CONCURRENCY);
  assert.equal(normalizeAttachmentStatusTimeoutMs(undefined), ATTACHMENT_STATUS_DEFAULT_TIMEOUT_MS);
  assert.equal(normalizeAttachmentStatusTimeoutMs('25'), 25);
  assert.equal(normalizeAttachmentStatusTimeoutMs(-1), ATTACHMENT_STATUS_DEFAULT_TIMEOUT_MS);
  assert.equal(normalizeAttachmentStatusTimeoutMs(50_000), ATTACHMENT_STATUS_MAX_TIMEOUT_MS);
});

test('refresh validates its dependency contract', async () => {
  await assert.rejects(() => refreshAttachmentStatuses(null, {}), /rows must be an array/);
  await assert.rejects(() => refreshAttachmentStatuses([], undefined), /jobStatus must be a function/);
  await assert.rejects(() => refreshAttachmentStatuses([], { updateStatus() {} }), /jobStatus must be a function/);
  await assert.rejects(() => refreshAttachmentStatuses([], { jobStatus() {} }), /updateStatus must be a function/);
});

test('empty and settled rows perform no downstream work', async () => {
  const dependencies = {
    jobStatus: async () => { throw new Error('must not run'); },
    updateStatus: () => { throw new Error('must not run'); },
  };
  assert.deepEqual(await refreshAttachmentStatuses([], dependencies), {
    attempted: 0, changed: 0, failed: 0, deferred: 0,
  });
  const metrics = {};
  assert.deepEqual(
    await refreshAttachmentStatuses([null, { id: 1, status: 'SUCCEEDED', jobId: 'job-1' }], { ...dependencies, metrics }),
    { attempted: 0, changed: 0, failed: 0, deferred: 0 },
  );
  assert.deepEqual(metrics, {
    attachmentStatusRefreshAttempted: 0,
    attachmentStatusRefreshChanged: 0,
    attachmentStatusRefreshFailed: 0,
    attachmentStatusRefreshDeferred: 0,
  });
});

test('100 pending rows respect configured concurrency and persist only changes', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    jobId: `job-${index + 1}`,
    status: index % 3 === 0 ? 'RUNNING' : 'PENDING',
  }));
  let active = 0;
  let peak = 0;
  const updates = [];
  const metrics = {
    attachmentStatusRefreshAttempted: 10,
    attachmentStatusRefreshChanged: 20,
    attachmentStatusRefreshFailed: 30,
    attachmentStatusRefreshDeferred: 40,
  };
  const counts = await refreshAttachmentStatuses(rows, {
    orgId: 7,
    userId: 9,
    concurrency: 8,
    timeoutMs: 1_000,
    metrics,
    jobStatus: async (orgId, userId, jobId, { signal }) => {
      assert.equal(orgId, 7);
      assert.equal(userId, 9);
      assert.equal(signal.aborted, false);
      active += 1;
      peak = Math.max(peak, active);
      const rowNumber = Number(jobId.split('-')[1]);
      await new Promise((resolve) => setTimeout(resolve, rowNumber % 3));
      active -= 1;
      return rowNumber % 2 === 0 ? 'SUCCEEDED' : rows[rowNumber - 1].status;
    },
    updateStatus: async (status, attachmentId) => updates.push([status, attachmentId]),
  });
  assert.ok(peak <= 8, `peak concurrency ${peak} exceeded configured limit`);
  assert.deepEqual(counts, { attempted: 100, changed: 50, failed: 0, deferred: 0 });
  assert.equal(updates.length, 50);
  assert.deepEqual(metrics, {
    attachmentStatusRefreshAttempted: 110,
    attachmentStatusRefreshChanged: 70,
    attachmentStatusRefreshFailed: 30,
    attachmentStatusRefreshDeferred: 40,
  });
});

test('invalid identifiers and downstream, timeout, or write failures remain isolated', async () => {
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
  const counts = await refreshAttachmentStatuses(rows, {
    concurrency: 3,
    timeoutMs: 5,
    jobStatus: async (_orgId, _userId, jobId, { signal }) => {
      if (jobId === 'throws') throw new Error('downstream failure');
      if (jobId === 'invalid-status') return 'UNKNOWN';
      if (jobId === 'write-fails') return 'SUCCEEDED';
      return new Promise(() => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      });
    },
    updateStatus: () => { throw new Error('write failure'); },
  });
  assert.equal(aborted, true);
  assert.deepEqual(counts, { attempted: 4, changed: 0, failed: 4, deferred: 3 });
  assert.equal(rows[5].status, 'PENDING');
  assert.equal(rows[6].status, 'PENDING');
});
