// Clearfolio(통합 문서 뷰어) 클라이언트 — 산출물 첨부 변환/열람 프록시.
// 실서버: CLEARFOLIO_URL(+선택 CLEARFOLIO_HMAC_SECRET) 설정 시 사용.
// 미설정 시 내장 MOCK(즉시 SUCCEEDED, 바이트 인메모리)으로 전 플로우 테스트 가능.
import { createHmac } from 'node:crypto';

const CF_URL = (process.env.CLEARFOLIO_URL || '').replace(/\/$/, '');
const CF_SECRET = process.env.CLEARFOLIO_HMAC_SECRET || '';
const PERMISSIONS = 'job:create,job:read,viewer:read,artifact-link:create';

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
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting ScopeWeave user identifier.
 * @param {{name:string,mime:string,bytes:Buffer|Uint8Array}} document - Conversion payload.
 * @returns {Promise<{jobId:string,status:string}>} Downstream job identity and initial status.
 * @throws {Error} If Clearfolio rejects the request or omits a job identifier.
 */
export async function submitJob(orgId, userId, { name, mime, bytes }) {
  if (clearfolioMock) {
    const jobId = `mockcf-${++mockSeq}`;
    mockDocs.set(jobId, { name, mime, bytes });
    return { jobId, status: 'SUCCEEDED' };
  }
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), name);
  const res = await fetch(`${CF_URL}/api/v1/convert/jobs`, {
    method: 'POST',
    headers: tenantHeaders(orgId, userId),
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.jobId) {
    throw new Error(data.message || `clearfolio submit failed (${res.status})`);
  }
  return { jobId: data.jobId, status: data.status || 'PENDING' };
}

/**
 * Read a Clearfolio conversion status with optional caller cancellation.
 *
 * Non-success HTTP responses throw instead of being converted to `FAILED`.
 * This allows the bounded refresh engine to preserve the previously persisted
 * status when Clearfolio itself is temporarily unavailable or rejects a request.
 *
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting user identifier.
 * @param {string} jobId - Clearfolio conversion job identifier.
 * @param {{signal?:AbortSignal}} [options] - Optional request cancellation signal.
 * @returns {Promise<string>} Downstream conversion status.
 * @throws {Error} If Clearfolio returns a non-success HTTP status.
 */
export async function jobStatus(orgId, userId, jobId, { signal } = {}) {
  if (clearfolioMock) return mockDocs.has(jobId) ? 'SUCCEEDED' : 'FAILED';
  const res = await fetch(`${CF_URL}/api/v1/convert/jobs/${encodeURIComponent(jobId)}`, {
    headers: tenantHeaders(orgId, userId),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`clearfolio status failed (${res.status})`);
  return data.status || 'FAILED';
}

/**
 * Issue a viewable artifact URL for a completed Clearfolio job.
 *
 * The hosted path prefers Clearfolio's external PDF.js viewer when an
 * `artifactToken` is available and falls back to the signed artifact URL.
 *
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting ScopeWeave user identifier.
 * @param {string} jobId - Completed conversion job identifier.
 * @returns {Promise<string>} Relative mock path or absolute hosted artifact URL.
 * @throws {Error} If Clearfolio cannot issue an artifact link.
 */
export async function artifactUrl(orgId, userId, jobId) {
  if (clearfolioMock) return `/api/mock-clearfolio/${encodeURIComponent(jobId)}`;
  const res = await fetch(`${CF_URL}/api/v1/viewer/${encodeURIComponent(jobId)}/artifact-links`, {
    method: 'POST',
    headers: tenantHeaders(orgId, userId),
  });
  const data = await res.json().catch(() => ({}));
  const link = data.artifactUrl || data.url || data.signedUrl;
  if (!res.ok || !link) {
    throw new Error(data.message || `clearfolio artifact-link failed (${res.status})`);
  }
  // PDF.js 뷰어 페이지 우선(clearfolio external artifactToken 모드): 토큰을
  // 추출해 /viewer/{docId}?artifactToken=… 으로 보낸다. 실패 시 원시 아티팩트.
  try {
    const url = new URL(link, CF_URL);
    const token = url.searchParams.get('artifactToken');
    if (token) {
      return `${CF_URL}/viewer/${encodeURIComponent(jobId)}?artifactToken=${encodeURIComponent(token)}`;
    }
  } catch {
    // Fall through to the signed raw artifact link.
  }
  return link.startsWith('http') ? link : `${CF_URL}${link}`;
}
