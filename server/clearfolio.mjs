// Clearfolio(통합 문서 뷰어) 클라이언트 — 산출물 첨부 변환/열람 프록시.
// 실서버: CLEARFOLIO_URL(+선택 CLEARFOLIO_HMAC_SECRET) 설정 시 사용.
// 미설정 시 내장 MOCK(즉시 SUCCEEDED, 바이트 인메모리)으로 전 플로우 테스트 가능.
import { createHmac } from 'node:crypto';

const CF_URL = (process.env.CLEARFOLIO_URL || '').replace(/\/$/, '');
const CF_SECRET = process.env.CLEARFOLIO_HMAC_SECRET || '';
const PERMISSIONS = 'job:create,job:read,viewer:read,artifact-link:create';

/** Whether ScopeWeave is using its in-memory Clearfolio development adapter. */
export const clearfolioMock = !CF_URL;

/**
 * Sign Clearfolio tenant claims using the TenantAccessService wire contract.
 *
 * @param {string|number} tenantId - Clearfolio tenant identifier.
 * @param {string|number} subjectId - Clearfolio subject identifier.
 * @param {string} permissions - Comma-separated permission set.
 * @param {string|number} issuedAt - Claim issue time in epoch seconds.
 * @param {string} secret - Shared HMAC secret.
 * @returns {string} Unpadded base64url HMAC-SHA256 signature.
 */
export function signClaims(tenantId, subjectId, permissions, issuedAt, secret) {
  const payload = [tenantId, subjectId, permissions, issuedAt].join('\n');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

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
 * @returns {{name:string,mime:string,bytes:Uint8Array}|null} Stored artifact or null.
 */
export const mockArtifact = (jobId) => mockDocs.get(jobId) || null;

/**
 * Submit a document-conversion job to Clearfolio or the in-memory adapter.
 *
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting user identifier.
 * @param {{name:string,mime:string,bytes:Uint8Array}} document - Uploaded document.
 * @returns {Promise<{jobId:string,status:string}>} Conversion job identity and status.
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
 * Read a Clearfolio conversion status with optional caller-owned cancellation.
 *
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting user identifier.
 * @param {string} jobId - Clearfolio conversion job identifier.
 * @param {{signal?:AbortSignal}} [options] - Optional request cancellation signal.
 * @returns {Promise<string>} Downstream conversion status.
 */
export async function jobStatus(orgId, userId, jobId, { signal } = {}) {
  if (clearfolioMock) return mockDocs.has(jobId) ? 'SUCCEEDED' : 'FAILED';
  const res = await fetch(`${CF_URL}/api/v1/convert/jobs/${encodeURIComponent(jobId)}`, {
    headers: tenantHeaders(orgId, userId),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  return data.status || 'FAILED';
}

/**
 * Issue an artifact-view URL for a completed Clearfolio job.
 *
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting user identifier.
 * @param {string} jobId - Clearfolio conversion job identifier.
 * @returns {Promise<string>} ScopeWeave mock URL or absolute Clearfolio viewer URL.
 */
export async function artifactUrl(orgId, userId, jobId) {
  if (clearfolioMock) return `/api/mock-clearfolio/${encodeURIComponent(jobId)}`;
  const res = await fetch(
    `${CF_URL}/api/v1/viewer/${encodeURIComponent(jobId)}/artifact-links`,
    {
      method: 'POST',
      headers: tenantHeaders(orgId, userId),
    },
  );
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
  } catch { /* fall through to raw link */ }
  return link.startsWith('http') ? link : `${CF_URL}${link}`;
}
