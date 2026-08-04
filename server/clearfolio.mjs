// Clearfolio(통합 문서 뷰어) 클라이언트 — 산출물 첨부 변환/열람 프록시.
// 실서버: CLEARFOLIO_URL(+선택 CLEARFOLIO_HMAC_SECRET) 설정 시 사용.
// 미설정 시 내장 MOCK(즉시 SUCCEEDED, 바이트 인메모리)으로 전 플로우 테스트 가능.
import { createHmac } from 'node:crypto';

const CF_URL = (process.env.CLEARFOLIO_URL || '').replace(/\/$/, '');
const CF_SECRET = process.env.CLEARFOLIO_HMAC_SECRET || '';
const PERMISSIONS = 'job:create,job:read,viewer:read,artifact-link:create';
const CLEARFOLIO_JOB_STATUSES = new Set(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']);

/** Whether the process uses the in-memory Clearfolio development adapter. */
export const clearfolioMock = !CF_URL;

/**
 * Sign tenant claims using the Clearfolio HMAC interoperability contract.
 *
 * The payload is the newline-delimited tenant ID, subject ID, permissions, and
 * issued-at epoch value. The signature is unpadded base64url HMAC-SHA256.
 *
 * @param {string} tenantId - Clearfolio tenant identifier.
 * @param {string} subjectId - Clearfolio subject identifier.
 * @param {string} permissions - Comma-separated permission contract.
 * @param {string|number} issuedAt - Epoch-second issue time.
 * @param {string} secret - Shared HMAC secret.
 * @returns {string} Unpadded base64url signature.
 */
export function signClaims(tenantId, subjectId, permissions, issuedAt, secret) {
  const payload = [tenantId, subjectId, permissions, issuedAt].join('\n');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Build tenant-scoped Clearfolio request headers without exposing credentials.
 *
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting ScopeWeave user identifier.
 * @returns {Record<string,string>} Tenant, subject, permission, and optional HMAC headers.
 */
function tenantHeaders(orgId, userId) {
  const tenantId = `sw-org-${orgId}`;
  const subjectId = `sw-user-${userId}`;
  const headers = {
    'X-Clearfolio-Tenant-Id': tenantId,
    'X-Clearfolio-Subject-Id': subjectId,
    'X-Clearfolio-Permissions': PERMISSIONS,
  };
  if (CF_SECRET) {
    const issuedAt = String(Math.floor(Date.now() / 1000));
    headers['X-Clearfolio-Claims-Issued-At'] = issuedAt;
    headers['X-Clearfolio-Claims-Signature'] = signClaims(
      tenantId,
      subjectId,
      PERMISSIONS,
      issuedAt,
      CF_SECRET,
    );
  }
  return headers;
}

/**
 * Test whether an untrusted parsed JSON value is a plain record-like object.
 *
 * Arrays and null are rejected so property access cannot silently accept an
 * incompatible downstream response shape.
 *
 * @param {unknown} value - Parsed downstream JSON value.
 * @returns {value is Record<string, unknown>} Whether the value is a non-array object.
 */
function isJsonRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Test whether an untrusted value is an exact Clearfolio conversion state.
 *
 * Whitespace-padded and unknown strings are rejected rather than normalized so
 * the database cannot persist a state outside the documented workflow contract.
 *
 * @param {unknown} value - Parsed downstream status value.
 * @returns {value is string} Whether the value is an exact accepted state.
 */
function isClearfolioJobStatus(value) {
  return typeof value === 'string' && CLEARFOLIO_JOB_STATUSES.has(value);
}

// ---- mock store (dev/test 전용; 재시작 시 소실) ----
const mockDocs = new Map(); // jobId -> { name, mime, bytes }
let mockSeq = 0;

/**
 * Read one in-memory mock artifact.
 *
 * @param {string} jobId - Mock conversion job identifier.
 * @returns {{name:string,mime:string,bytes:Buffer}|null} Stored artifact or null.
 */
export const mockArtifact = (jobId) => mockDocs.get(jobId) || null;

/**
 * Submit a document conversion job through Clearfolio or the local mock.
 *
 * Downstream response text and transport errors are never copied into the
 * thrown error because the caller may serialize that message to a browser.
 *
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting ScopeWeave user identifier.
 * @param {{name:string,mime:string,bytes:Buffer|Uint8Array}} document - Conversion payload.
 * @returns {Promise<{jobId:string,status:string}>} Downstream job identity and initial status.
 * @throws {Error} If Clearfolio is unavailable, rejects the request, or returns a malformed response.
 */
export async function submitJob(orgId, userId, { name, mime, bytes }) {
  if (clearfolioMock) {
    const jobId = `mockcf-${++mockSeq}`;
    mockDocs.set(jobId, { name, mime, bytes });
    return { jobId, status: 'SUCCEEDED' };
  }
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), name);
  let res;
  try {
    res = await fetch(`${CF_URL}/api/v1/convert/jobs`, {
      method: 'POST',
      headers: tenantHeaders(orgId, userId),
      body: form,
    });
  } catch {
    throw new Error('clearfolio submit unavailable');
  }
  if (!res.ok) throw new Error(`clearfolio submit failed (${res.status})`);
  const data = await res.json().catch(() => null);
  if (!isJsonRecord(data)) throw new Error('clearfolio submit response invalid');
  const status = data.status === undefined ? 'PENDING' : data.status;
  if (
    typeof data.jobId !== 'string'
    || data.jobId.trim().length === 0
    || !isClearfolioJobStatus(status)
  ) {
    throw new Error('clearfolio submit response invalid');
  }
  return { jobId: data.jobId.trim(), status };
}

/**
 * Read a Clearfolio conversion status with optional caller cancellation.
 *
 * Transport failures, non-success HTTP responses, and successful responses
 * without an exact documented conversion state all throw fixed operation-level
 * errors. The bounded refresh engine can therefore preserve the previously
 * persisted state without logging or returning private downstream details.
 *
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting user identifier.
 * @param {string} jobId - Clearfolio conversion job identifier.
 * @param {{signal?:AbortSignal}} [options] - Optional request cancellation signal.
 * @returns {Promise<string>} Validated downstream conversion status.
 * @throws {Error} If Clearfolio is unavailable, rejects the request, or returns a malformed status.
 */
export async function jobStatus(orgId, userId, jobId, { signal } = {}) {
  if (clearfolioMock) return mockDocs.has(jobId) ? 'SUCCEEDED' : 'FAILED';
  let res;
  try {
    res = await fetch(`${CF_URL}/api/v1/convert/jobs/${encodeURIComponent(jobId)}`, {
      headers: tenantHeaders(orgId, userId),
      signal,
    });
  } catch {
    throw new Error('clearfolio status unavailable');
  }
  if (!res.ok) throw new Error(`clearfolio status failed (${res.status})`);
  const data = await res.json().catch(() => null);
  if (!isJsonRecord(data) || !isClearfolioJobStatus(data.status)) {
    throw new Error('clearfolio status response invalid');
  }
  return data.status;
}

/**
 * Issue a viewable artifact URL for a completed Clearfolio job.
 *
 * The hosted path prefers Clearfolio's external PDF.js viewer when an
 * `artifactToken` is available and otherwise returns a validated HTTP(S) URL.
 * Downstream response text and transport errors are never exposed to callers.
 * An HTTPS Clearfolio deployment cannot downgrade an artifact link to HTTP.
 *
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting ScopeWeave user identifier.
 * @param {string} jobId - Completed conversion job identifier.
 * @returns {Promise<string>} Relative mock path or validated absolute artifact URL.
 * @throws {Error} If Clearfolio is unavailable, rejects the request, or returns an invalid link.
 */
export async function artifactUrl(orgId, userId, jobId) {
  if (clearfolioMock) return `/api/mock-clearfolio/${encodeURIComponent(jobId)}`;
  let res;
  try {
    res = await fetch(`${CF_URL}/api/v1/viewer/${encodeURIComponent(jobId)}/artifact-links`, {
      method: 'POST',
      headers: tenantHeaders(orgId, userId),
    });
  } catch {
    throw new Error('clearfolio artifact-link unavailable');
  }
  if (!res.ok) throw new Error(`clearfolio artifact-link failed (${res.status})`);
  const data = await res.json().catch(() => null);
  if (!isJsonRecord(data)) throw new Error('clearfolio artifact-link response invalid');
  const link = data.artifactUrl || data.url || data.signedUrl;
  if (typeof link !== 'string' || link.length === 0) {
    throw new Error('clearfolio artifact-link response invalid');
  }

  let url;
  let clearfolioUrl;
  try {
    clearfolioUrl = new URL(CF_URL);
    url = new URL(link, clearfolioUrl);
  } catch {
    throw new Error('clearfolio artifact-link response invalid');
  }
  const allowsHttp = clearfolioUrl.protocol === 'http:' && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !allowsHttp) {
    throw new Error('clearfolio artifact-link response invalid');
  }

  // PDF.js 뷰어 페이지 우선(clearfolio external artifactToken 모드): 토큰을
  // 추출해 /viewer/{docId}?artifactToken=… 으로 보낸다. 없으면 검증한 URL.
  const token = url.searchParams.get('artifactToken');
  if (token) {
    return `${CF_URL}/viewer/${encodeURIComponent(jobId)}?artifactToken=${encodeURIComponent(token)}`;
  }
  return url.href;
}
