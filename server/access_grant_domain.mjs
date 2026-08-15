import { createHash } from 'node:crypto';

const TOKEN_BYTES = 32;
const GRANT_ID_BYTES = 16;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TTL_SECONDS = 300;

/** Supported short-lived grant purposes in this bounded domain slice. */
export const ACCESS_GRANT_PURPOSES = Object.freeze({
  STREAM: 'stream',
  ATTACHMENT_VIEW: 'attachment_view',
});

/** Fixed resource-server audiences paired with each supported grant purpose. */
export const ACCESS_GRANT_AUDIENCES = Object.freeze({
  STREAM: 'scopeweave:stream',
  ATTACHMENT_VIEW: 'scopeweave:attachment-view',
});

const PURPOSE_AUDIENCE = Object.freeze({
  [ACCESS_GRANT_PURPOSES.STREAM]: ACCESS_GRANT_AUDIENCES.STREAM,
  [ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW]: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
});

/**
 * Stable domain error safe for route adapters to map without exposing grant state.
 */
export class AccessGrantError extends Error {
  /**
   * @param {string} code Stable machine-readable error code.
   * @param {number} status Suggested HTTP status for a thin route adapter.
   */
  constructor(code, status) {
    super(code);
    this.name = 'AccessGrantError';
    this.code = code;
    this.status = status;
  }
}

function requireMethod(port, method) {
  if (!port || typeof port[method] !== 'function') {
    throw new TypeError(`access-grant dependency must provide ${method}()`);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeAttachmentId(purpose, attachmentId) {
  if (purpose === ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW) {
    return isNonEmptyString(attachmentId) ? attachmentId : undefined;
  }
  return attachmentId === undefined || attachmentId === null ? null : undefined;
}

function validateMintRequest({ subjectId, projectId, purpose, audience, attachmentId, ttlSeconds }) {
  const expectedAudience = PURPOSE_AUDIENCE[purpose];
  const normalizedAttachmentId = normalizeAttachmentId(purpose, attachmentId);
  if (
    !isNonEmptyString(subjectId)
    || !isNonEmptyString(projectId)
    || !expectedAudience
    || audience !== expectedAudience
    || normalizedAttachmentId === undefined
  ) {
    throw new AccessGrantError('access_grant_request_invalid', 400);
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new AccessGrantError('access_grant_ttl_invalid', 400);
  }
  return { expectedAudience, normalizedAttachmentId };
}

function validateRedeemBinding({ purpose, audience, projectId, attachmentId }) {
  const expectedAudience = PURPOSE_AUDIENCE[purpose];
  const normalizedAttachmentId = normalizeAttachmentId(purpose, attachmentId);
  if (
    !expectedAudience
    || audience !== expectedAudience
    || !isNonEmptyString(projectId)
    || normalizedAttachmentId === undefined
  ) {
    throw unauthorizedGrant();
  }
  return { normalizedAttachmentId };
}

function unauthorizedGrant() {
  return new AccessGrantError('access_grant_unauthorized', 401);
}

function hashSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function encodeSecret(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== TOKEN_BYTES) {
    throw new TypeError(`access-grant random source must return ${TOKEN_BYTES} bytes`);
  }
  return Buffer.from(bytes).toString('base64url');
}

function encodeGrantId(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== GRANT_ID_BYTES) {
    throw new TypeError(`access-grant random source must return ${GRANT_ID_BYTES} bytes for grant id`);
  }
  return `agr_${Buffer.from(bytes).toString('hex')}`;
}

function readNow(clock) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('access-grant clock must return a non-negative safe integer');
  }
  return nowMs;
}

/**
 * Build a framework-neutral short-lived access-grant service.
 *
 * The repository owns durable state and must implement one-time consumption as
 * an atomic transition. The service owns validation, purpose/audience binding,
 * hash-only persistence, membership re-checks, and secret-free audit events.
 * Calendar subscription secrets intentionally remain out of scope because they
 * require a separate rotation/revocation lifecycle.
 *
 * @param {object} ports Injected infrastructure and authorization ports.
 * @param {object} ports.repository AccessGrantRepository implementation.
 * @param {object} ports.clock AccessGrantClock with nowMs().
 * @param {object} ports.randomSource AccessGrantRandomSource with randomBytes().
 * @param {object} ports.auditSink AccessGrantAuditSink with record().
 * @param {object} ports.projectAuthorization ProjectAuthorizationPort.
 * @param {object} ports.membershipRevocation MembershipRevocationPort.
 * @returns {{mint: Function, redeem: Function}} Immutable grant service.
 */
export function createAccessGrantService({
  repository,
  clock,
  randomSource,
  auditSink,
  projectAuthorization,
  membershipRevocation,
} = {}) {
  requireMethod(repository, 'insertGrant');
  requireMethod(repository, 'findGrantByHash');
  requireMethod(repository, 'consumeGrantAtomically');
  requireMethod(clock, 'nowMs');
  requireMethod(randomSource, 'randomBytes');
  requireMethod(auditSink, 'record');
  requireMethod(projectAuthorization, 'assertCanIssue');
  requireMethod(membershipRevocation, 'assertActive');

  async function mint({ subjectId, projectId, purpose, audience, attachmentId, ttlSeconds }) {
    const { expectedAudience, normalizedAttachmentId } = validateMintRequest({
      subjectId,
      projectId,
      purpose,
      audience,
      attachmentId,
      ttlSeconds,
    });
    try {
      await projectAuthorization.assertCanIssue({
        subjectId,
        projectId,
        purpose,
        attachmentId: normalizedAttachmentId,
      });
    } catch {
      throw new AccessGrantError('access_grant_not_authorized', 404);
    }

    const nowMs = readNow(clock);
    const expiresAtMs = nowMs + (ttlSeconds * 1000);
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new AccessGrantError('access_grant_ttl_invalid', 400);
    }
    const secret = encodeSecret(randomSource.randomBytes(TOKEN_BYTES));
    const tokenHash = hashSecret(secret);
    const grantId = encodeGrantId(randomSource.randomBytes(GRANT_ID_BYTES));
    const record = {
      grant_id: grantId,
      token_hash: tokenHash,
      subject_id: subjectId,
      project_id: projectId,
      purpose,
      audience: expectedAudience,
      attachment_id: normalizedAttachmentId,
      issued_at_ms: nowMs,
      expires_at_ms: expiresAtMs,
      used_at_ms: null,
      revoked_at_ms: null,
    };
    await repository.insertGrant(record);
    await auditSink.record({
      event: 'access_grant.minted',
      grant_id: grantId,
      subject_id: subjectId,
      project_id: projectId,
      purpose,
      audience: expectedAudience,
      attachment_id: normalizedAttachmentId,
      expires_at_ms: expiresAtMs,
    });
    return Object.freeze({
      secret,
      grantId,
      subjectId,
      projectId,
      purpose,
      audience: expectedAudience,
      attachmentId: normalizedAttachmentId,
      expiresAtMs,
    });
  }

  async function redeem({ secret, purpose, audience, projectId, attachmentId }) {
    if (typeof secret !== 'string' || !TOKEN_PATTERN.test(secret)) throw unauthorizedGrant();
    const { normalizedAttachmentId } = validateRedeemBinding({ purpose, audience, projectId, attachmentId });
    const tokenHash = hashSecret(secret);
    const existing = await repository.findGrantByHash(tokenHash);
    if (!existing) throw unauthorizedGrant();
    try {
      await membershipRevocation.assertActive({
        subjectId: existing.subject_id,
        projectId: existing.project_id,
      });
    } catch {
      throw unauthorizedGrant();
    }
    const consumed = await repository.consumeGrantAtomically(tokenHash, {
      now_ms: readNow(clock),
      purpose,
      audience,
      project_id: projectId,
      attachment_id: normalizedAttachmentId,
    });
    if (!consumed) throw unauthorizedGrant();
    await auditSink.record({
      event: 'access_grant.consumed',
      grant_id: consumed.grant_id,
      subject_id: consumed.subject_id,
      project_id: consumed.project_id,
      purpose: consumed.purpose,
      audience: consumed.audience,
      attachment_id: consumed.attachment_id,
    });
    return Object.freeze({
      grantId: consumed.grant_id,
      subjectId: consumed.subject_id,
      projectId: consumed.project_id,
      purpose: consumed.purpose,
      audience: consumed.audience,
      attachmentId: consumed.attachment_id,
    });
  }

  return Object.freeze({ mint, redeem });
}
