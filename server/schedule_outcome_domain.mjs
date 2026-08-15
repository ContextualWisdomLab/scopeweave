const DAY_MS = 86_400_000;
const TERMINAL_REASON_TYPES = new Set(['skipped', 'cancelled', 'not_performed']);
const BLOCKER_KINDS = new Set(['dependency', 'decision', 'constraint']);

/**
 * Mutually exclusive schedule outcomes emitted by the ScopeWeave derivation domain.
 * A null outcome is intentionally possible when required evidence is missing; it
 * is never replaced with a synthetic failure category.
 */
export const SCHEDULE_OUTCOMES = Object.freeze([
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

/** Version identifier persisted beside derived outcome evidence. */
export const SCHEDULE_OUTCOME_DERIVATION_VERSION = 'schedule-outcome/v1';

/**
 * Derive one decision-ready schedule outcome from explicit baseline and execution facts.
 *
 * The function deliberately separates observed facts from interpretation. Missing
 * approved baseline data or untouched work after its execution window produces a
 * null outcome plus an explicit next decision rather than silently inferring failure.
 * Explicit skip/cancel/not-performed reason events are validated as auditable facts,
 * and unresolved dependency/decision/constraint blockers are treated separately from
 * completion status. Returned provenance is immutable and contains no caller-owned
 * mutable object references.
 *
 * Calendar variance uses whole ISO-8601 calendar days in UTC. This makes leap-day
 * boundaries deterministic and avoids deployment-time-zone drift. The configurable
 * on-time tolerance is symmetric around the approved baseline finish date.
 *
 * @param {unknown} input schedule facts and explicit reason/blocker evidence
 * @returns {Readonly<{
 *   outcome: string|null,
 *   derivationVersion: string,
 *   decisionRequired: string|null,
 *   explanation: Readonly<Record<string, unknown>>
 * }>} immutable outcome decision and provenance
 * @throws {TypeError|Error} when supplied evidence is malformed or contradictory
 */
export function deriveScheduleOutcome(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('schedule outcome input must be an object');
  }

  const baselineVersion = requireText(input.baselineVersion, 'baselineVersion');
  const baselineFinish = parseCalendarDate(input.baselineFinishDate, 'baselineFinishDate', true);
  const executionWindowEnd = parseCalendarDate(input.executionWindowEndDate, 'executionWindowEndDate');
  const asOf = parseCalendarDate(input.asOfDate, 'asOfDate');
  const actualStart = parseCalendarDate(input.actualStartDate, 'actualStartDate', true);
  const actualFinish = parseCalendarDate(input.actualFinishDate, 'actualFinishDate', true);
  const progressPercent = requirePercentage(input.progressPercent);
  const onTimeToleranceDays = requireTolerance(input.onTimeToleranceDays);
  const reasonEvent = normalizeReasonEvent(input.reasonEvent, asOf.epochDay);
  const blockers = normalizeBlockers(input.blockers, asOf.epochDay);

  if (actualStart && actualStart.epochDay > asOf.epochDay) {
    throw new Error('actualStartDate cannot be after asOfDate');
  }
  if (actualFinish && actualFinish.epochDay > asOf.epochDay) {
    throw new Error('actualFinishDate cannot be after asOfDate');
  }
  if (actualStart && actualFinish && actualFinish.epochDay < actualStart.epochDay) {
    throw new Error('actualFinishDate cannot precede actualStartDate');
  }
  if (actualFinish && progressPercent !== 100) {
    throw new Error('actualFinishDate requires 100 percent progress');
  }

  const actualEvidencePresent = actualStart !== null || actualFinish !== null || progressPercent > 0;
  const executionWindowConcluded = asOf.epochDay > executionWindowEnd.epochDay;
  const unresolvedBlockers = blockers.filter((blocker) => blocker.resolvedAt === null);

  if (actualFinish && reasonEvent) {
    throw new Error('completed work cannot also carry a terminal reason outcome');
  }
  if (actualFinish && unresolvedBlockers.length > 0) {
    throw new Error('completed work cannot remain blocked');
  }
  if (reasonEvent?.type === 'not_performed' && !executionWindowConcluded) {
    throw new Error('not_performed requires a concluded execution window');
  }
  if (reasonEvent?.type === 'not_performed' && actualEvidencePresent) {
    throw new Error('not_performed cannot coexist with actual execution evidence');
  }

  let outcome = null;
  let decisionRequired = null;
  let finishVarianceDays = null;

  if (actualFinish) {
    if (!baselineFinish) {
      decisionRequired = 'approve_baseline_finish';
    } else {
      finishVarianceDays = actualFinish.epochDay - baselineFinish.epochDay;
      if (finishVarianceDays < -onTimeToleranceDays) {
        outcome = 'completed_early';
      } else if (finishVarianceDays > onTimeToleranceDays) {
        outcome = 'completed_late';
      } else {
        outcome = 'completed_on_time';
      }
    }
  } else if (reasonEvent) {
    outcome = reasonEvent.type;
  } else if (unresolvedBlockers.length > 0) {
    outcome = 'blocked';
  } else if (actualEvidencePresent) {
    outcome = 'in_progress';
  } else if (!executionWindowConcluded) {
    outcome = 'not_started';
  } else {
    decisionRequired = 'record_execution_outcome';
  }

  const sourceFacts = Object.freeze({
    baselineVersion,
    baselineFinishDate: baselineFinish?.value ?? null,
    executionWindowEndDate: executionWindowEnd.value,
    asOfDate: asOf.value,
    actualStartDate: actualStart?.value ?? null,
    actualFinishDate: actualFinish?.value ?? null,
    progressPercent,
    onTimeToleranceDays,
  });
  const frozenReasonEvent = reasonEvent ? Object.freeze({ ...reasonEvent }) : null;
  const frozenBlockers = Object.freeze(blockers.map((blocker) => Object.freeze({ ...blocker })));
  const explanation = Object.freeze({
    sourceFacts,
    reasonEvent: frozenReasonEvent,
    blockers: frozenBlockers,
    actualEvidencePresent,
    executionWindowConcluded,
    unresolvedBlockerCount: unresolvedBlockers.length,
    finishVarianceDays,
  });

  return Object.freeze({
    outcome,
    derivationVersion: SCHEDULE_OUTCOME_DERIVATION_VERSION,
    decisionRequired,
    explanation,
  });
}

/** @param {unknown} value text input @param {string} field field name @returns {string} */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field} must be non-blank text without control characters`);
  }
  return value;
}

/**
 * Parse one strict ISO calendar date into its UTC day number.
 * @param {unknown} value candidate date
 * @param {string} field field name
 * @param {boolean} nullable whether null/undefined is accepted
 * @returns {{value: string, epochDay: number}|null}
 */
function parseCalendarDate(value, field, nullable = false) {
  if ((value === null || value === undefined) && nullable) {
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError(`${field} must be an ISO calendar date`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a real ISO calendar date`);
  }
  return { value, epochDay: timestamp / DAY_MS };
}

/** @param {unknown} value candidate progress @returns {number} */
function requirePercentage(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError('progressPercent must be a finite number from 0 through 100');
  }
  return value;
}

/** @param {unknown} value candidate calendar-day tolerance @returns {number} */
function requireTolerance(value) {
  if (!Number.isInteger(value) || value < 0 || value > 365) {
    throw new TypeError('onTimeToleranceDays must be an integer from 0 through 365');
  }
  return value;
}

/**
 * Normalize one explicit terminal reason event.
 * @param {unknown} value candidate reason event
 * @param {number} asOfEpochDay current observation day
 * @returns {{type: string, reasonCode: string, actorId: string, occurredAt: string, approvalId?: string}|null}
 */
function normalizeReasonEvent(value, asOfEpochDay) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('reasonEvent must be an object');
  }
  if (!TERMINAL_REASON_TYPES.has(value.type)) {
    throw new TypeError('reasonEvent.type is unsupported');
  }
  const reasonCode = requireText(value.reasonCode, 'reasonEvent.reasonCode');
  const actorId = requireText(value.actorId, 'reasonEvent.actorId');
  const occurredAt = requireTimestamp(value.occurredAt, 'reasonEvent.occurredAt', asOfEpochDay);
  if (value.type === 'cancelled') {
    return {
      type: value.type,
      reasonCode,
      actorId,
      occurredAt,
      approvalId: requireText(value.approvalId, 'reasonEvent.approvalId'),
    };
  }
  return { type: value.type, reasonCode, actorId, occurredAt };
}

/**
 * Normalize blocker evidence while preserving resolved history.
 * @param {unknown} value candidate blocker array
 * @param {number} asOfEpochDay current observation day
 * @returns {Array<{kind: string, referenceId: string, recordedAt: string, resolvedAt: string|null}>}
 */
function normalizeBlockers(value, asOfEpochDay) {
  if (!Array.isArray(value)) {
    throw new TypeError('blockers must be an array');
  }
  return value.map((blocker) => {
    if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) {
      throw new TypeError('blocker must be an object');
    }
    if (!BLOCKER_KINDS.has(blocker.kind)) {
      throw new TypeError('blocker.kind is unsupported');
    }
    const referenceId = requireText(blocker.referenceId, 'blocker.referenceId');
    const recordedAt = requireTimestamp(blocker.recordedAt, 'blocker.recordedAt', asOfEpochDay);
    const resolvedAt = blocker.resolvedAt === null || blocker.resolvedAt === undefined
      ? null
      : requireTimestamp(blocker.resolvedAt, 'blocker.resolvedAt', asOfEpochDay);
    if (resolvedAt !== null && Date.parse(resolvedAt) < Date.parse(recordedAt)) {
      throw new Error('blocker.resolvedAt cannot precede blocker.recordedAt');
    }
    return { kind: blocker.kind, referenceId, recordedAt, resolvedAt };
  });
}

/**
 * Validate an auditable timestamp and reject future-dated evidence.
 * @param {unknown} value candidate timestamp
 * @param {string} field field name
 * @param {number} asOfEpochDay current observation day
 * @returns {string}
 */
function requireTimestamp(value, field, asOfEpochDay) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${field} must be a real timestamp`);
  }
  const evidenceEpochDay = Math.floor(timestamp / DAY_MS);
  if (evidenceEpochDay > asOfEpochDay) {
    throw new Error(`${field} cannot be after asOfDate`);
  }
  return value;
}
