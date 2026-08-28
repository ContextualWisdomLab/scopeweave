import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshAttachmentStatuses } from '../../server/attachment_status.mjs';

const HMAC_SECRET = 'clearfolio-shared-secret-32-bytes!!';
const originalFetch = globalThis.fetch;
process.env.CLEARFOLIO_URL = 'https://clearfolio.example';
process.env.CLEARFOLIO_HMAC_SECRET = HMAC_SECRET;

globalThis.fetch = async () => {
  throw new DOMException('private provider timeout detail', 'TimeoutError');
};

const { jobStatus } = await import(
  '../../server/clearfolio.mjs?refresh-timeout-classification-test=1'
);

test.after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLEARFOLIO_URL;
  delete process.env.CLEARFOLIO_HMAC_SECRET;
});

test('provider timeout stays sanitized and is counted as a refresh timeout', async () => {
  await assert.rejects(
    () => jobStatus(1, 2, 'job-timeout'),
    (error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.message, 'clearfolio status unavailable');
      assert.doesNotMatch(error.message, /private provider timeout detail/);
      return true;
    },
  );

  const rows = [{ id: 1, jobId: 'job-timeout', status: 'PENDING' }];
  const categories = [];
  const metrics = {};
  const counts = await refreshAttachmentStatuses(rows, {
    orgId: 1,
    userId: 2,
    timeoutMs: 30_000,
    budgetMs: 60_000,
    metrics,
    onError: ({ category }) => categories.push(category),
    jobStatus,
    updateStatus: () => {
      throw new Error('timed-out status must not be persisted');
    },
  });

  assert.deepEqual(counts, {
    attempted: 1,
    changed: 0,
    failed: 1,
    skipped: 0,
    deferred: 0,
  });
  assert.deepEqual(categories, ['timeout']);
  assert.equal(metrics.attachmentStatusRefreshTimeoutFailures, 1);
  assert.equal(metrics.attachmentStatusRefreshDownstreamLookupFailures, 0);
  assert.equal(rows[0].status, 'PENDING');
});

test('a persistence TimeoutError remains a persistence failure', async () => {
  const rows = [{ id: 1, jobId: 'job-ready', status: 'PENDING' }];
  const categories = [];
  const metrics = {};
  const counts = await refreshAttachmentStatuses(rows, {
    orgId: 1,
    userId: 2,
    timeoutMs: 30_000,
    budgetMs: 60_000,
    metrics,
    onError: ({ category }) => categories.push(category),
    jobStatus: async () => 'READY',
    updateStatus: async () => {
      throw new DOMException('storage deadline', 'TimeoutError');
    },
  });

  assert.deepEqual(counts, {
    attempted: 1,
    changed: 0,
    failed: 1,
    skipped: 0,
    deferred: 0,
  });
  assert.deepEqual(categories, ['status_persistence']);
  assert.equal(metrics.attachmentStatusRefreshTimeoutFailures, 0);
  assert.equal(metrics.attachmentStatusRefreshPersistenceFailures, 1);
  assert.equal(rows[0].status, 'PENDING');
});
