const REASON_ACTIONS = Object.freeze({
  skipped: 'schedule_outcome.skip',
  cancelled: 'schedule_outcome.cancel',
  not_performed: 'schedule_outcome.not_performed',
});
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const OPAQUE_ID = /^(?=.{8,128}$)(?=.*[A-Za-z])[A-Za-z0-9._:-]+$/u;

/** Explicit terminal reason events supported by the schedule-intelligence contract. */
export const SCHEDULE_REASON_EVENT_TYPES = Object.freeze([
  'skipped',
  'cancelled',
  'not_performed',
]);

/** Version identifier stored with reason-event authorization evidence. */
export const SCHEDULE_REASON_EVENT_CONTRACT_VERSION = 'schedule-reason-event/v1';

/**
 * Authorize and atomically record one explicit terminal schedule reason.
 *
 * This boundary keeps caller-provided reason facts separate from trusted authority.
 * The authorization adapter must bind its decision to the exact organization,
 * project, work item, actor, action, and expected work-item version. Cancellation
 * additionally requires an independently verified approval reference bound to the
 * same work-item version. The repository adapter receives one event plus the same
 * expected resource version and is responsible for committing the event and its
 * audit record atomically while enforcing optimistic concurrency.
 *
 * The function never accepts a browser assertion as authorization, never derives a
 * cancellation approval from an identifier alone, and never retries a stale write.
 * A denied or stale authorization/approval stops before persistence. Returned event
 * and receipt objects are copied and frozen so mutable adapter responses cannot
 * rewrite audit provenance after the fact.
 *
 * @param {unknown} input caller reason facts and exact resource identity
 * @param {unknown} ports trusted clock, random, authorization, approval, and repository adapters
 * @returns {Promise<Readonly<{
 *   event: Readonly<Record<string, unknown>>,
 *   receipt: Readonly<{auditRecordId: string, resourceVersion: string}>
 * }>>} immutable committed reason event and audit receipt
 * @throws {TypeError|Error} when input, authority evidence, or persistence evidence is invalid
 */
export async function recordScheduleReasonEvent(input, ports) {
  const normalized = normalizeInput(input);
  const adapters = requirePorts(ports);
  const observedAt = requireCanonicalTimestamp(adapters.clock.now(), 'clock.now()');
  const occurredAt = requireCanonicalTimestamp(normalized.occurredAt, 'occurredAt');
  if (Date.parse(occurredAt) > Date.parse(observedAt)) {
    throw new Error('occurredAt cannot be after the trusted clock');
  }

  const eventId = requireOpaqueId(adapters.randomSource.nextOpaqueId(), 'generated eventId');
  const authorizationRequest = Object.freeze({
    organizationId: normalized.organizationId,
    projectId: normalized.projectId,
    workItemId: normalized.workItemId,
    actorId: normalized.actorId,
    action: REASON_ACTIONS[normalized.type],
    expectedResourceVersion: normalized.expectedWorkItemVersion,
  });
  const authorization = await adapters.authorizationPort.authorize(authorizationRequest);
  const trustedAuthorization = normalizeAuthorization(
    authorization,
    normalized.expectedWorkItemVersion,
  );

  let approval = null;
  if (normalized.type === 'cancelled') {
    const approvalRequest = Object.freeze({
      organizationId: normalized.organizationId,
      projectId: normalized.projectId,
      workItemId: normalized.workItemId,
      actorId: normalized.actorId,
      approvalRef: normalized.approvalRef,
      expectedResourceVersion: normalized.expectedWorkItemVersion,
    });
    const approvalSnapshot = await adapters.approvalPort.verifyCancellationApproval(approvalRequest);
    approval = normalizeApproval(
      approvalSnapshot,
      normalized.expectedWorkItemVersion,
      normalized.actorId,
    );
  }

  const event = Object.freeze({
    eventId,
    contractVersion: SCHEDULE_REASON_EVENT_CONTRACT_VERSION,
    organizationId: normalized.organizationId,
    projectId: normalized.projectId,
    workItemId: normalized.workItemId,
    expectedWorkItemVersion: normalized.expectedWorkItemVersion,
    type: normalized.type,
    reasonCode: normalized.reasonCode,
    actorId: normalized.actorId,
    occurredAt,
    observedAt,
    authorizationId: trustedAuthorization.authorizationId,
    approval,
  });

  const commitRequest = Object.freeze({
    event,
    expectedResourceVersion: normalized.expectedWorkItemVersion,
  });
  const commitResult = await adapters.repositoryPort.commitReasonEvent(commitRequest);
  const receipt = normalizeCommitReceipt(commitResult, eventId);

  return Object.freeze({ event, receipt });
}

/** Normalize caller facts before invoking any trusted adapter. */
function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('schedule reason event input must be an object');
  }

  const organizationId = requireText(input.organizationId, 'organizationId');
  const projectId = requireText(input.projectId, 'projectId');
  const workItemId = requireText(input.workItemId, 'workItemId');
  const actorId = requireText(input.actorId, 'actorId');
  const expectedWorkItemVersion = requireText(
    input.expectedWorkItemVersion,
    'expectedWorkItemVersion',
  );
  if (!SCHEDULE_REASON_EVENT_TYPES.includes(input.type)) {
    throw new TypeError('type must be skipped, cancelled, or not_performed');
  }
  const reasonCode = requireText(input.reasonCode, 'reasonCode');
  const occurredAt = input.occurredAt;

  if (input.type === 'cancelled') {
    if (input.approvalRef === null || input.approvalRef === undefined) {
      throw new TypeError('cancelled events require approvalRef');
    }
  } else if (input.approvalRef !== null && input.approvalRef !== undefined) {
    throw new TypeError('approvalRef is only valid for cancelled events');
  }

  const approvalRef = input.type === 'cancelled'
    ? requireText(input.approvalRef, 'approvalRef')
    : null;
  requireCanonicalTimestamp(occurredAt, 'occurredAt');

  return {
    organizationId,
    projectId,
    workItemId,
    actorId,
    expectedWorkItemVersion,
    type: input.type,
    reasonCode,
    occurredAt,
    approvalRef,
  };
}

/** Require every authority-bearing adapter explicitly rather than falling back. */
function requirePorts(ports) {
  if (!ports || typeof ports !== 'object' || Array.isArray(ports)) {
    throw new TypeError('schedule reason event ports must be an object');
  }
  requireFunction(ports.clock?.now, 'clock.now');
  requireFunction(ports.randomSource?.nextOpaqueId, 'randomSource.nextOpaqueId');
  requireFunction(ports.authorizationPort?.authorize, 'authorizationPort.authorize');
  requireFunction(
    ports.approvalPort?.verifyCancellationApproval,
    'approvalPort.verifyCancellationApproval',
  );
  requireFunction(ports.repositoryPort?.commitReasonEvent, 'repositoryPort.commitReasonEvent');
  return ports;
}

/** Validate a successful authorization snapshot and its resource binding. */
function normalizeAuthorization(value, expectedResourceVersion) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.allowed !== true) {
    throw new Error('schedule reason event authorization denied');
  }
  const authorizationId = requireText(value.authorizationId, 'authorization.authorizationId');
  const resourceVersion = requireText(value.resourceVersion, 'authorization.resourceVersion');
  if (resourceVersion !== expectedResourceVersion) {
    throw new Error('authorization resource version is stale');
  }
  return { authorizationId };
}

/** Validate cancellation approval evidence returned by a trusted approval adapter. */
function normalizeApproval(value, expectedResourceVersion, actorId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.valid !== true) {
    throw new Error('cancellation approval denied');
  }
  const approvalId = requireText(value.approvalId, 'approval.approvalId');
  const approverId = requireText(value.approverId, 'approval.approverId');
  const authorizationId = requireText(value.authorizationId, 'approval.authorizationId');
  const resourceVersion = requireText(value.resourceVersion, 'approval.resourceVersion');
  if (resourceVersion !== expectedResourceVersion) {
    throw new Error('approval resource version is stale');
  }
  if (approverId === actorId) {
    throw new Error('cancellation approver must be distinct from the acting user');
  }
  return Object.freeze({ approvalId, approverId, authorizationId });
}

/** Validate that persistence committed this exact event with an auditable receipt. */
function normalizeCommitReceipt(value, expectedEventId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.committed !== true) {
    throw new Error('schedule reason event commit failed');
  }
  if (value.eventId !== expectedEventId) {
    throw new Error('schedule reason event commit returned a different eventId');
  }
  const auditRecordId = requireText(value.auditRecordId, 'commit.auditRecordId');
  const resourceVersion = requireText(value.resourceVersion, 'commit.resourceVersion');
  return Object.freeze({ auditRecordId, resourceVersion });
}

/** Require a callable adapter member. */
function requireFunction(value, field) {
  if (typeof value !== 'function') {
    throw new TypeError(`${field} must be a function`);
  }
}

/** Require bounded non-blank text without control characters. */
function requireText(value, field) {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > 256
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new TypeError(`${field} must be bounded non-blank text without control characters`);
  }
  return value;
}

/** Require a canonical UTC ISO-8601 timestamp with millisecond precision. */
function requireCanonicalTimestamp(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

/** Require a non-sequential opaque identifier suitable for a public event identity. */
function requireOpaqueId(value, field) {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new TypeError(`${field} must be an opaque string identifier`);
  }
  return value;
}
