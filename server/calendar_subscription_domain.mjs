import { createHash } from 'node:crypto';

const SECRET_BYTES = 32;
const SUBSCRIPTION_ID_BYTES = 16;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NAME_MAX_LENGTH = 120;
const MEMBERSHIP_VERSION_MAX_LENGTH = 128;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

/** Fixed resource-server audience for reusable project calendar subscriptions. */
export const CALENDAR_SUBSCRIPTION_AUDIENCE = 'scopeweave:calendar';

/** Stable domain error safe for thin HTTP adapters to map without secret-state disclosure. */
export class CalendarSubscriptionError extends Error {
  /**
   * @param {string} code Stable machine-readable error code.
   * @param {number} status Suggested HTTP status for an adapter.
   */
  constructor(code, status) {
    super(code);
    this.name = 'CalendarSubscriptionError';
    this.code = code;
    this.status = status;
  }
}

function requireMethod(port, method) {
  if (!port || typeof port[method] !== 'function') {
    throw new TypeError(`calendar-subscription dependency must provide ${method}()`);
  }
}

function isBoundedString(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !CONTROL_PATTERN.test(value);
}

function normalizeName(value) {
  if (!isBoundedString(value) || value.length > NAME_MAX_LENGTH) {
    throw new CalendarSubscriptionError('calendar_subscription_request_invalid', 400);
  }
  return value;
}

function validateIdentity(subjectId, projectId) {
  if (!isBoundedString(subjectId) || !isBoundedString(projectId)) {
    throw new CalendarSubscriptionError('calendar_subscription_request_invalid', 400);
  }
}

function normalizeSubscriptionId(value) {
  if (!isBoundedString(value)) {
    throw new CalendarSubscriptionError('calendar_subscription_request_invalid', 400);
  }
  return value;
}

function readNow(clock) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('calendar-subscription clock must return a non-negative safe integer');
  }
  return nowMs;
}

function normalizeExpiry(expiresAtMs, nowMs) {
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new CalendarSubscriptionError('calendar_subscription_expiry_invalid', 400);
  }
  return expiresAtMs;
}

function normalizeMembershipVersion(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MEMBERSHIP_VERSION_MAX_LENGTH
    && value === value.trim()
    && !CONTROL_PATTERN.test(value)
  ) return value;
  throw unauthorizedSubscription();
}

function encodeSecret(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== SECRET_BYTES) {
    throw new TypeError(`calendar-subscription random source must return ${SECRET_BYTES} bytes`);
  }
  return Buffer.from(bytes).toString('base64url');
}

function encodeSubscriptionId(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== SUBSCRIPTION_ID_BYTES) {
    throw new TypeError(`calendar-subscription random source must return ${SUBSCRIPTION_ID_BYTES} bytes for subscription id`);
  }
  return `csub_${Buffer.from(bytes).toString('hex')}`;
}

function hashSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function unauthorizedSubscription() {
  return new CalendarSubscriptionError('calendar_subscription_unauthorized', 401);
}

function notFoundSubscription() {
  return new CalendarSubscriptionError('calendar_subscription_not_found', 404);
}

function statusOf(record, nowMs) {
  if (record.revoked_at_ms !== null && record.revoked_at_ms !== undefined) return 'revoked';
  if (record.expires_at_ms <= nowMs) return 'expired';
  return 'active';
}

function viewOf(record, nowMs) {
  return Object.freeze({
    subscriptionId: record.subscription_id,
    subjectId: record.subject_id,
    projectId: record.project_id,
    name: record.name,
    audience: record.audience,
    createdAtMs: record.created_at_ms,
    expiresAtMs: record.expires_at_ms,
    lastUsedAtMs: record.last_used_at_ms ?? null,
    rotatedAtMs: record.rotated_at_ms ?? null,
    revokedAtMs: record.revoked_at_ms ?? null,
    status: statusOf(record, nowMs),
  });
}

async function recordAuditBestEffort(auditSink, event) {
  try {
    await auditSink.record(event);
  } catch {
    // Durable subscription state is authoritative after the repository commits.
    // Production persistence that requires guaranteed evidence should pair the
    // state transition with a transactional outbox rather than retrying secrets.
  }
}

async function assertManage(projectAuthorization, subjectId, projectId) {
  try {
    await projectAuthorization.assertCanManage({ subjectId, projectId });
  } catch {
    throw notFoundSubscription();
  }
}

async function readMembershipVersion(membershipRevocation, subjectId, projectId) {
  try {
    return normalizeMembershipVersion(await membershipRevocation.assertActive({ subjectId, projectId }));
  } catch {
    throw unauthorizedSubscription();
  }
}

/**
 * Build the framework-neutral lifecycle for reusable calendar-subscription secrets.
 *
 * Plaintext subscription secrets are returned only from create/rotate and only
 * their SHA-256 hashes cross the repository port. Repository adapters own the
 * durable `calendar_subscriptions`, `subscription_rotations`, and
 * `subscription_usage_events` state and must make usage/rotation/revocation
 * transitions atomic. `recordUsageAtomically()` and
 * `rotateSubscriptionAtomically()` must compare the supplied membership version
 * with live membership state in the same transaction, closing the
 * revoke-between-check-and-use race. Adapters without a shared transaction must
 * atomically revoke affected subscriptions when membership changes.
 *
 * Audit delivery is best-effort after repository commits so an audit transport
 * outage cannot cause a client to retry and accidentally expose multiple active
 * secrets. Production adapters that require durable audit evidence should use a
 * transactional outbox.
 *
 * @param {object} ports Injected infrastructure and authorization ports.
 * @param {object} ports.repository CalendarSubscriptionRepository.
 * @param {object} ports.clock Clock exposing nowMs().
 * @param {object} ports.randomSource Random source exposing randomBytes().
 * @param {object} ports.auditSink Secret-free audit sink exposing record().
 * @param {object} ports.projectAuthorization Project authorization port.
 * @param {object} ports.membershipRevocation Membership revocation/version port.
 * @returns {{create: Function, list: Function, authorize: Function, rotate: Function, revoke: Function}} Immutable service.
 */
export function createCalendarSubscriptionService({
  repository,
  clock,
  randomSource,
  auditSink,
  projectAuthorization,
  membershipRevocation,
} = {}) {
  requireMethod(repository, 'insertSubscription');
  requireMethod(repository, 'listSubscriptions');
  requireMethod(repository, 'findSubscriptionByHash');
  requireMethod(repository, 'recordUsageAtomically');
  requireMethod(repository, 'rotateSubscriptionAtomically');
  requireMethod(repository, 'revokeSubscriptionAtomically');
  requireMethod(clock, 'nowMs');
  requireMethod(randomSource, 'randomBytes');
  requireMethod(auditSink, 'record');
  requireMethod(projectAuthorization, 'assertCanManage');
  requireMethod(membershipRevocation, 'assertActive');

  async function create({ subjectId, projectId, name, expiresAtMs }) {
    validateIdentity(subjectId, projectId);
    const normalizedName = normalizeName(name);
    await assertManage(projectAuthorization, subjectId, projectId);
    const membershipVersion = await readMembershipVersion(membershipRevocation, subjectId, projectId);
    const nowMs = readNow(clock);
    const normalizedExpiry = normalizeExpiry(expiresAtMs, nowMs);
    const secret = encodeSecret(randomSource.randomBytes(SECRET_BYTES));
    const subscriptionId = encodeSubscriptionId(randomSource.randomBytes(SUBSCRIPTION_ID_BYTES));
    const record = {
      subscription_id: subscriptionId,
      secret_hash: hashSecret(secret),
      subject_id: subjectId,
      project_id: projectId,
      name: normalizedName,
      audience: CALENDAR_SUBSCRIPTION_AUDIENCE,
      membership_version: membershipVersion,
      created_at_ms: nowMs,
      expires_at_ms: normalizedExpiry,
      last_used_at_ms: null,
      rotated_at_ms: null,
      revoked_at_ms: null,
    };
    await repository.insertSubscription(record);
    await recordAuditBestEffort(auditSink, {
      event: 'calendar_subscription.created',
      subscription_id: subscriptionId,
      subject_id: subjectId,
      project_id: projectId,
      audience: CALENDAR_SUBSCRIPTION_AUDIENCE,
      expires_at_ms: normalizedExpiry,
    });
    return Object.freeze({ secret, ...viewOf(record, nowMs) });
  }

  async function list({ subjectId, projectId }) {
    validateIdentity(subjectId, projectId);
    await assertManage(projectAuthorization, subjectId, projectId);
    const nowMs = readNow(clock);
    const records = await repository.listSubscriptions({ subject_id: subjectId, project_id: projectId });
    if (!Array.isArray(records)) throw new TypeError('calendar-subscription repository must return an array from listSubscriptions()');
    return Object.freeze(records.map((record) => viewOf(record, nowMs)));
  }

  async function authorize({ secret, projectId }) {
    if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret) || !isBoundedString(projectId)) {
      throw unauthorizedSubscription();
    }
    const secretHash = hashSecret(secret);
    const existing = await repository.findSubscriptionByHash(secretHash);
    if (!existing || existing.project_id !== projectId || existing.audience !== CALENDAR_SUBSCRIPTION_AUDIENCE) {
      throw unauthorizedSubscription();
    }
    const membershipVersion = await readMembershipVersion(
      membershipRevocation,
      existing.subject_id,
      existing.project_id,
    );
    const used = await repository.recordUsageAtomically(secretHash, {
      now_ms: readNow(clock),
      project_id: projectId,
      audience: CALENDAR_SUBSCRIPTION_AUDIENCE,
      membership_version: membershipVersion,
    });
    if (!used) throw unauthorizedSubscription();
    await recordAuditBestEffort(auditSink, {
      event: 'calendar_subscription.used',
      subscription_id: used.subscription_id,
      subject_id: used.subject_id,
      project_id: used.project_id,
      audience: used.audience,
    });
    return Object.freeze({
      subscriptionId: used.subscription_id,
      subjectId: used.subject_id,
      projectId: used.project_id,
      audience: used.audience,
    });
  }

  async function rotate({ subjectId, projectId, subscriptionId, expiresAtMs }) {
    validateIdentity(subjectId, projectId);
    const normalizedSubscriptionId = normalizeSubscriptionId(subscriptionId);
    await assertManage(projectAuthorization, subjectId, projectId);
    const membershipVersion = await readMembershipVersion(membershipRevocation, subjectId, projectId);
    const nowMs = readNow(clock);
    const normalizedExpiry = normalizeExpiry(expiresAtMs, nowMs);
    const secret = encodeSecret(randomSource.randomBytes(SECRET_BYTES));
    const rotated = await repository.rotateSubscriptionAtomically(normalizedSubscriptionId, {
      subject_id: subjectId,
      project_id: projectId,
      new_secret_hash: hashSecret(secret),
      now_ms: nowMs,
      expires_at_ms: normalizedExpiry,
      membership_version: membershipVersion,
    });
    if (!rotated) throw notFoundSubscription();
    await recordAuditBestEffort(auditSink, {
      event: 'calendar_subscription.rotated',
      subscription_id: rotated.subscription_id,
      subject_id: rotated.subject_id,
      project_id: rotated.project_id,
      audience: rotated.audience,
      expires_at_ms: rotated.expires_at_ms,
    });
    return Object.freeze({ secret, ...viewOf(rotated, nowMs) });
  }

  async function revoke({ subjectId, projectId, subscriptionId }) {
    validateIdentity(subjectId, projectId);
    const normalizedSubscriptionId = normalizeSubscriptionId(subscriptionId);
    await assertManage(projectAuthorization, subjectId, projectId);
    const nowMs = readNow(clock);
    const revoked = await repository.revokeSubscriptionAtomically(normalizedSubscriptionId, {
      subject_id: subjectId,
      project_id: projectId,
      now_ms: nowMs,
    });
    if (!revoked) throw notFoundSubscription();
    await recordAuditBestEffort(auditSink, {
      event: 'calendar_subscription.revoked',
      subscription_id: revoked.subscription_id,
      subject_id: revoked.subject_id,
      project_id: revoked.project_id,
      audience: revoked.audience,
    });
    return viewOf(revoked, nowMs);
  }

  return Object.freeze({ create, list, authorize, rotate, revoke });
}
