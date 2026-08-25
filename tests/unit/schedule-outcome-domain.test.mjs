import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCHEDULE_OUTCOMES,
  SCHEDULE_OUTCOME_DERIVATION_VERSION,
  deriveScheduleOutcome,
} from '../../server/schedule_outcome_domain.mjs';

const baseInput = (overrides = {}) => ({
  baselineVersion: 'baseline-v7',
  baselineFinishDate: '2026-03-10',
  executionWindowEndDate: '2026-03-10',
  asOfDate: '2026-03-09',
  actualStartDate: null,
  actualFinishDate: null,
  progressPercent: 0,
  onTimeToleranceDays: 0,
  reasonEvent: null,
  blockers: [],
  ...overrides,
});

test('exports a frozen mutually-exclusive outcome vocabulary and derivation version', () => {
  assert.deepEqual(SCHEDULE_OUTCOMES, [
    'not_started',
    'in_progress',
    'completed_early',
    'completed_on_time',
    'completed_late',
    'not_performed',
    'skipped',
    'cancelled',
    'blocked',
  ]);
  assert.equal(Object.isFrozen(SCHEDULE_OUTCOMES), true);
  assert.equal(SCHEDULE_OUTCOME_DERIVATION_VERSION, 'schedule-outcome/v1');
});

test('keeps untouched work not_started until its execution window has concluded', () => {
  const result = deriveScheduleOutcome(baseInput());

  assert.equal(result.outcome, 'not_started');
  assert.equal(result.decisionRequired, null);
  assert.equal(result.explanation.executionWindowConcluded, false);
  assert.equal(result.explanation.actualEvidencePresent, false);
});

test('does not silently label untouched overdue work as failure', () => {
  const result = deriveScheduleOutcome(baseInput({ asOfDate: '2026-03-11' }));

  assert.equal(result.outcome, null);
  assert.equal(result.decisionRequired, 'record_execution_outcome');
  assert.equal(result.explanation.executionWindowConcluded, true);
  assert.equal(result.explanation.actualEvidencePresent, false);
});

test('derives in_progress from actual execution evidence without a completion date', () => {
  for (const evidence of [
    { actualStartDate: '2026-03-01' },
    { progressPercent: 1 },
    { actualStartDate: '2026-03-01', progressPercent: 75 },
  ]) {
    const result = deriveScheduleOutcome(baseInput({ ...evidence, asOfDate: '2026-03-11' }));
    assert.equal(result.outcome, 'in_progress');
    assert.equal(result.decisionRequired, null);
  }
});

test('classifies completion around a symmetric calendar-day tolerance with leap-day arithmetic', () => {
  const common = {
    baselineFinishDate: '2028-03-01',
    executionWindowEndDate: '2028-03-01',
    asOfDate: '2028-03-05',
    actualStartDate: '2028-02-20',
    progressPercent: 100,
    onTimeToleranceDays: 1,
  };

  const early = deriveScheduleOutcome(baseInput({ ...common, actualFinishDate: '2028-02-28' }));
  const lowerBoundary = deriveScheduleOutcome(baseInput({ ...common, actualFinishDate: '2028-02-29' }));
  const exact = deriveScheduleOutcome(baseInput({ ...common, actualFinishDate: '2028-03-01' }));
  const upperBoundary = deriveScheduleOutcome(baseInput({ ...common, actualFinishDate: '2028-03-02' }));
  const late = deriveScheduleOutcome(baseInput({ ...common, actualFinishDate: '2028-03-03' }));

  assert.equal(early.outcome, 'completed_early');
  assert.equal(early.explanation.finishVarianceDays, -2);
  assert.equal(lowerBoundary.outcome, 'completed_on_time');
  assert.equal(lowerBoundary.explanation.finishVarianceDays, -1);
  assert.equal(exact.outcome, 'completed_on_time');
  assert.equal(exact.explanation.finishVarianceDays, 0);
  assert.equal(upperBoundary.outcome, 'completed_on_time');
  assert.equal(upperBoundary.explanation.finishVarianceDays, 1);
  assert.equal(late.outcome, 'completed_late');
  assert.equal(late.explanation.finishVarianceDays, 2);
});

test('requires an approved baseline finish before assigning a completion outcome', () => {
  const result = deriveScheduleOutcome(baseInput({
    baselineFinishDate: null,
    actualStartDate: '2026-03-01',
    actualFinishDate: '2026-03-09',
    progressPercent: 100,
  }));

  assert.equal(result.outcome, null);
  assert.equal(result.decisionRequired, 'approve_baseline_finish');
  assert.equal(result.explanation.finishVarianceDays, null);
});

test('uses explicit reason events for skipped, cancelled, and not_performed outcomes', () => {
  const cases = [
    {
      type: 'skipped',
      reasonCode: 'duplicate_scope',
      actorId: 'user-17',
      occurredAt: '2026-03-08T09:30:00Z',
    },
    {
      type: 'cancelled',
      reasonCode: 'scope_removed',
      actorId: 'user-17',
      occurredAt: '2026-03-08T09:30:00Z',
      approvalId: 'approval-42',
    },
    {
      type: 'not_performed',
      reasonCode: 'vendor_unavailable',
      actorId: 'owner-9',
      occurredAt: '2026-03-11T01:00:00Z',
    },
  ];

  for (const reasonEvent of cases) {
    const result = deriveScheduleOutcome(baseInput({
      asOfDate: '2026-03-11',
      reasonEvent,
    }));
    assert.equal(result.outcome, reasonEvent.type);
    assert.deepEqual(result.explanation.reasonEvent, reasonEvent);
    assert.equal(Object.isFrozen(result.explanation.reasonEvent), true);
  }
});

test('does not allow not_performed before the execution window concludes', () => {
  assert.throws(
    () => deriveScheduleOutcome(baseInput({
      reasonEvent: {
        type: 'not_performed',
        reasonCode: 'owner_confirmed',
        actorId: 'owner-9',
        occurredAt: '2026-03-09T10:00:00Z',
      },
    })),
    /not_performed requires a concluded execution window/,
  );
});

test('derives blocked only from a currently unresolved recorded blocker', () => {
  const result = deriveScheduleOutcome(baseInput({
    actualStartDate: '2026-03-01',
    progressPercent: 40,
    blockers: [{
      kind: 'dependency',
      referenceId: 'dep-88',
      recordedAt: '2026-03-05T02:00:00Z',
      resolvedAt: null,
    }],
  }));
  const resolved = deriveScheduleOutcome(baseInput({
    actualStartDate: '2026-03-01',
    progressPercent: 40,
    blockers: [{
      kind: 'dependency',
      referenceId: 'dep-88',
      recordedAt: '2026-03-05T02:00:00Z',
      resolvedAt: '2026-03-06T02:00:00Z',
    }],
  }));

  assert.equal(result.outcome, 'blocked');
  assert.equal(result.explanation.unresolvedBlockerCount, 1);
  assert.equal(resolved.outcome, 'in_progress');
  assert.equal(resolved.explanation.unresolvedBlockerCount, 0);
});

test('fails closed on contradictory terminal evidence instead of choosing a convenient label', () => {
  assert.throws(
    () => deriveScheduleOutcome(baseInput({
      actualFinishDate: '2026-03-09',
      progressPercent: 100,
      reasonEvent: {
        type: 'cancelled',
        reasonCode: 'scope_removed',
        actorId: 'user-17',
        occurredAt: '2026-03-09T10:00:00Z',
        approvalId: 'approval-42',
      },
    })),
    /completed work cannot also carry a terminal reason outcome/,
  );

  assert.throws(
    () => deriveScheduleOutcome(baseInput({
      actualStartDate: '2026-03-01',
      progressPercent: 10,
      reasonEvent: {
        type: 'not_performed',
        reasonCode: 'owner_confirmed',
        actorId: 'owner-9',
        occurredAt: '2026-03-11T01:00:00Z',
      },
      asOfDate: '2026-03-11',
    })),
    /not_performed cannot coexist with actual execution evidence/,
  );
});

test('returns immutable explanation provenance with source facts and baseline identity', () => {
  const reasonEvent = {
    type: 'skipped',
    reasonCode: 'duplicate_scope',
    actorId: 'user-17',
    occurredAt: '2026-03-08T09:30:00Z',
  };
  const input = baseInput({ reasonEvent });
  const result = deriveScheduleOutcome(input);

  assert.equal(result.derivationVersion, 'schedule-outcome/v1');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.explanation), true);
  assert.deepEqual(result.explanation.sourceFacts, {
    baselineVersion: 'baseline-v7',
    baselineFinishDate: '2026-03-10',
    executionWindowEndDate: '2026-03-10',
    asOfDate: '2026-03-09',
    actualStartDate: null,
    actualFinishDate: null,
    progressPercent: 0,
    onTimeToleranceDays: 0,
  });
  assert.equal(Object.isFrozen(result.explanation.sourceFacts), true);
  assert.notEqual(result.explanation.reasonEvent, reasonEvent, 'explanation must not retain mutable caller objects');
});

test('rejects malformed dates, percentages, tolerance, blockers, and reason events', () => {
  const invalidInputs = [
    { asOfDate: '2026-02-30' },
    { actualStartDate: '03/01/2026' },
    { progressPercent: -1 },
    { progressPercent: 101 },
    { progressPercent: Number.NaN },
    { onTimeToleranceDays: -1 },
    { onTimeToleranceDays: 1.5 },
    { baselineVersion: '   ' },
    { blockers: [{ kind: 'other', referenceId: 'x', recordedAt: '2026-03-01T00:00:00Z', resolvedAt: null }] },
    { reasonEvent: { type: 'skipped', reasonCode: '', actorId: 'user-1', occurredAt: '2026-03-01T00:00:00Z' } },
    { reasonEvent: { type: 'cancelled', reasonCode: 'scope_removed', actorId: 'user-1', occurredAt: '2026-03-01T00:00:00Z' } },
    { reasonEvent: { type: 'unknown', reasonCode: 'x', actorId: 'user-1', occurredAt: '2026-03-01T00:00:00Z' } },
  ];

  for (const overrides of invalidInputs) {
    assert.throws(() => deriveScheduleOutcome(baseInput(overrides)));
  }
});
