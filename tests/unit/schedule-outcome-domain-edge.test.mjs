import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveScheduleOutcome } from '../../server/schedule_outcome_domain.mjs';

const baseInput = (overrides = {}) => ({
  baselineVersion: 'baseline-v7',
  baselineFinishDate: '2026-03-10',
  executionWindowEndDate: '2026-03-10',
  asOfDate: '2026-03-11',
  actualStartDate: null,
  actualFinishDate: null,
  progressPercent: 0,
  onTimeToleranceDays: 0,
  reasonEvent: null,
  blockers: [],
  ...overrides,
});

const expectReject = (overrides, pattern) => {
  assert.throws(() => deriveScheduleOutcome(baseInput(overrides)), pattern);
};

test('rejects malformed top-level input and required scalar fields', () => {
  for (const value of [null, [], 'plan']) {
    assert.throws(() => deriveScheduleOutcome(value), /input must be an object/);
  }

  expectReject({ baselineVersion: '' }, /baselineVersion/);
  expectReject({ baselineVersion: 'bad\nversion' }, /baselineVersion/);
  expectReject({ executionWindowEndDate: null }, /executionWindowEndDate/);
  expectReject({ executionWindowEndDate: '2026-02-30' }, /executionWindowEndDate/);
  expectReject({ actualFinishDate: 'March 9, 2026' }, /actualFinishDate/);
  expectReject({ progressPercent: Infinity }, /progressPercent/);
  expectReject({ onTimeToleranceDays: 366 }, /onTimeToleranceDays/);
  expectReject({ onTimeToleranceDays: '1' }, /onTimeToleranceDays/);
});

test('rejects impossible temporal and completion evidence', () => {
  expectReject({ actualStartDate: '2026-03-12' }, /actualStartDate cannot be after/);
  expectReject({ actualFinishDate: '2026-03-12', progressPercent: 100 }, /actualFinishDate cannot be after/);
  expectReject({
    actualStartDate: '2026-03-09',
    actualFinishDate: '2026-03-08',
    progressPercent: 100,
  }, /actualFinishDate cannot precede/);
  expectReject({ actualFinishDate: '2026-03-09', progressPercent: 99 }, /requires 100 percent progress/);
  expectReject({
    actualFinishDate: '2026-03-09',
    progressPercent: 100,
    blockers: [{
      kind: 'constraint',
      referenceId: 'constraint-7',
      recordedAt: '2026-03-01T00:00:00Z',
      resolvedAt: null,
    }],
  }, /completed work cannot remain blocked/);
});

test('accepts boundary tolerance and completion without an actual-start record', () => {
  const result = deriveScheduleOutcome(baseInput({
    baselineFinishDate: '2026-03-10',
    actualFinishDate: '2026-03-11',
    progressPercent: 100,
    onTimeToleranceDays: 365,
  }));

  assert.equal(result.outcome, 'completed_on_time');
  assert.equal(result.explanation.sourceFacts.actualStartDate, null);
});

test('validates reason-event object shape, timestamps, and cancellation approval', () => {
  expectReject({ reasonEvent: [] }, /reasonEvent must be an object/);
  expectReject({ reasonEvent: { type: 'unknown' } }, /reasonEvent.type is unsupported/);
  expectReject({
    reasonEvent: {
      type: 'skipped',
      reasonCode: 'bad\u0000code',
      actorId: 'user-1',
      occurredAt: '2026-03-01T00:00:00Z',
    },
  }, /reasonEvent.reasonCode/);
  expectReject({
    reasonEvent: {
      type: 'skipped',
      reasonCode: 'duplicate_scope',
      actorId: '',
      occurredAt: '2026-03-01T00:00:00Z',
    },
  }, /reasonEvent.actorId/);
  expectReject({
    reasonEvent: {
      type: 'skipped',
      reasonCode: 'duplicate_scope',
      actorId: 'user-1',
      occurredAt: 'not-a-time',
    },
  }, /reasonEvent.occurredAt/);
  expectReject({
    reasonEvent: {
      type: 'skipped',
      reasonCode: 'duplicate_scope',
      actorId: 'user-1',
      occurredAt: '2026-03-12T00:00:00Z',
    },
  }, /cannot be after asOfDate/);
  expectReject({
    reasonEvent: {
      type: 'cancelled',
      reasonCode: 'scope_removed',
      actorId: 'user-1',
      occurredAt: '2026-03-01T00:00:00Z',
      approvalId: '   ',
    },
  }, /reasonEvent.approvalId/);
});

test('accepts undefined optional evidence without retaining mutable blocker arrays', () => {
  const input = baseInput({ reasonEvent: undefined, blockers: [{
    kind: 'decision',
    referenceId: 'decision-3',
    recordedAt: '2026-03-01T00:00:00Z',
    resolvedAt: undefined,
  }] });
  const result = deriveScheduleOutcome(input);

  assert.equal(result.outcome, 'blocked');
  assert.equal(Object.isFrozen(result.explanation.blockers), true);
  assert.equal(Object.isFrozen(result.explanation.blockers[0]), true);
  assert.notEqual(result.explanation.blockers, input.blockers);
});

test('validates blocker containers, kinds, identifiers, and lifecycle timestamps', () => {
  expectReject({ blockers: null }, /blockers must be an array/);
  expectReject({ blockers: [null] }, /blocker must be an object/);
  expectReject({ blockers: [[]] }, /blocker must be an object/);
  expectReject({ blockers: [{
    kind: 'risk',
    referenceId: 'risk-1',
    recordedAt: '2026-03-01T00:00:00Z',
    resolvedAt: null,
  }] }, /blocker.kind is unsupported/);
  expectReject({ blockers: [{
    kind: 'dependency',
    referenceId: '',
    recordedAt: '2026-03-01T00:00:00Z',
    resolvedAt: null,
  }] }, /blocker.referenceId/);
  expectReject({ blockers: [{
    kind: 'dependency',
    referenceId: 'dep-1',
    recordedAt: '',
    resolvedAt: null,
  }] }, /blocker.recordedAt/);
  expectReject({ blockers: [{
    kind: 'dependency',
    referenceId: 'dep-1',
    recordedAt: '2026-03-12T00:00:00Z',
    resolvedAt: null,
  }] }, /cannot be after asOfDate/);
  expectReject({ blockers: [{
    kind: 'dependency',
    referenceId: 'dep-1',
    recordedAt: '2026-03-03T00:00:00Z',
    resolvedAt: 'invalid',
  }] }, /blocker.resolvedAt/);
  expectReject({ blockers: [{
    kind: 'dependency',
    referenceId: 'dep-1',
    recordedAt: '2026-03-03T00:00:00Z',
    resolvedAt: '2026-03-12T00:00:00Z',
  }] }, /cannot be after asOfDate/);
  expectReject({ blockers: [{
    kind: 'dependency',
    referenceId: 'dep-1',
    recordedAt: '2026-03-03T00:00:00Z',
    resolvedAt: '2026-03-02T00:00:00Z',
  }] }, /cannot precede blocker.recordedAt/);
});

test('preserves resolved blocker history without classifying the work as blocked', () => {
  const result = deriveScheduleOutcome(baseInput({
    actualStartDate: '2026-03-01',
    progressPercent: 20,
    blockers: [
      {
        kind: 'decision',
        referenceId: 'decision-3',
        recordedAt: '2026-03-01T00:00:00Z',
        resolvedAt: '2026-03-02T00:00:00Z',
      },
      {
        kind: 'constraint',
        referenceId: 'constraint-4',
        recordedAt: '2026-03-02T00:00:00Z',
        resolvedAt: '2026-03-03T00:00:00Z',
      },
    ],
  }));

  assert.equal(result.outcome, 'in_progress');
  assert.equal(result.explanation.unresolvedBlockerCount, 0);
  assert.equal(result.explanation.blockers.length, 2);
});
