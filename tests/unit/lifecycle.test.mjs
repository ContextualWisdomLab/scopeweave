// Work-item + Service-Request status state machines (pure logic in server/lifecycle.mjs).
// Run: node tests/unit/lifecycle.test.mjs
import assert from 'node:assert';
import {
  TASK_STATUSES, canTransitionTask, deriveTaskStatus, applyTaskTransition, isTaskDone,
  SR_STATUSES, canTransitionSr, isSrLive,
} from '../../server/lifecycle.mjs';

// ---- task status transitions -------------------------------------------------
assert.deepEqual(TASK_STATUSES, ['open', 'in_progress', 'done', 'cancelled']);
assert.ok(canTransitionTask('open', 'in_progress'), 'open → in_progress');
assert.ok(canTransitionTask('in_progress', 'done'), 'in_progress → done');
assert.ok(canTransitionTask('done', 'in_progress'), 'done → in_progress (reopen)');
assert.ok(!canTransitionTask('open', 'done') === false, 'open → done allowed (shortcut)');
assert.ok(!canTransitionTask('done', 'open'), 'done → open NOT allowed directly');
assert.ok(!canTransitionTask('open', 'bogus'), 'unknown target rejected');
assert.ok(canTransitionTask('open', 'open'), 'idempotent no-op allowed');

// ---- derive status from legacy progress (no explicit status) -----------------
assert.equal(deriveTaskStatus({ actualProgress: 0 }), 'open', '0% → open');
assert.equal(deriveTaskStatus({ actualProgress: 55 }), 'in_progress', '55% → in_progress');
assert.equal(deriveTaskStatus({ actualProgress: 100 }), 'done', '100% → done');
assert.equal(deriveTaskStatus({ actualProgressStatus: 'PM확인(100%)' }), 'done', 'enum percent → done');
assert.equal(deriveTaskStatus({ actualProgressStatus: '미착수(0%)' }), 'open', 'enum 0% → open');
assert.equal(deriveTaskStatus({ status: 'in_progress', actualProgress: 0 }), 'in_progress', 'explicit status wins over percent');
assert.ok(isTaskDone({ actualProgress: 100 }), 'isTaskDone via percent');

// ---- applying a transition keeps progress coherent + never mutates input -----
const t0 = { id: 'x', actualProgress: 0 };
const t1 = applyTaskTransition(t0, 'done');
assert.equal(t1.status, 'done');
assert.equal(t1.actualProgress, 100, 'done forces 100% so EVM/rollup stay consistent');
assert.equal(t0.actualProgress, 0, 'input not mutated');
assert.equal(applyTaskTransition({ actualProgress: 100, status: 'done' }, 'in_progress').actualProgress, 50, 'reopen drops from 100%');
assert.throws(() => applyTaskTransition({ status: 'done' }, 'cancelled'), /invalid task status transition/, 'illegal transition throws');

// ---- service request state machine -------------------------------------------
assert.deepEqual(SR_STATUSES, ['submitted', 'approved', 'in_progress', 'fulfilled', 'closed', 'rejected', 'cancelled']);
assert.ok(canTransitionSr('submitted', 'approved'), 'submitted → approved');
assert.ok(canTransitionSr('submitted', 'rejected'), 'submitted → rejected');
assert.ok(canTransitionSr('approved', 'in_progress'), 'approved → in_progress');
assert.ok(canTransitionSr('in_progress', 'fulfilled'), 'in_progress → fulfilled');
assert.ok(canTransitionSr('fulfilled', 'closed'), 'fulfilled → closed');
assert.ok(canTransitionSr('fulfilled', 'in_progress'), 'fulfilled → in_progress (rollup regressed)');
assert.ok(!canTransitionSr('submitted', 'fulfilled'), 'cannot skip straight to fulfilled');
assert.ok(!canTransitionSr('closed', 'in_progress'), 'closed is terminal');
assert.ok(!canTransitionSr('approved', 'closed'), 'cannot close an unfulfilled request');

// ---- isSrLive: which states are rollup-driven --------------------------------
assert.ok(isSrLive('approved') && isSrLive('in_progress') && isSrLive('fulfilled'), 'live states');
assert.ok(!isSrLive('submitted') && !isSrLive('closed') && !isSrLive('rejected'), 'non-live states');

console.log('✓ lifecycle (task + service-request state machines) tests passed');
