// Clearfolio(통합 문서 뷰어) 클라이언트 — 산출물 첨부 변환/열람 프록시.
// Production requires both a service URL and tenant-claim HMAC secret. The
// in-memory adapter is available only under the explicit SCOPEWEAVE_DEV=1 boundary.
import { createHmac } from 'node:crypto';

const CF_URL = (process.env.CLEARFOLIO_URL || '').replace(/\/$/, '');
const CF_SECRET = process.env.CLEARFOLIO_HMAC_SECRET || '';
const PERMISSIONS = 'job:create,job:read,viewer:read,artifact-link:create';
const CLEARFOLIO_TIMEOUT_MS = 30_000;
const CLEARFOLIO_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const clearfolioMock = process.env.SCOPEWEAVE_DEV === '1' && !CF_URL;

/** Stable production configuration or provider-boundary failure. */
export class ClearfolioConfigurationError extends Error {
  /**
   * Create one operator-safe Clearfolio error.
   * @param {string} code machine-readable failure code
   * @param {string} message operator-safe detail
   */
  constructor(code, message) {
    super(message);
    this.name = 'ClearfolioConfigurationError';
    this.code = code;
  }
}

/**
 * Resolve the development adapter or complete production credentials.
 * @returns {{mock: true} | {mock: false, baseUrl: string, secret: string}}
 */
function clearfolioConfiguration() {
  if (clearfolioMock) return { mock: true };
  if (!CF_URL) {
    throw new ClearfolioConfigurationError(
      'clearfolio_not_configured',
      'Clearfolio is unavailable because CLEARFOLIO_URL is not configured.',
    );
  }
  let url;
  try {
    url = new URL(CF_URL);
  } catch {
    throw new ClearfolioConfigurationError(
      'clearfolio_url_invalid',
      'CLEARFOLIO_URL must be a valid absolute URL.',
    );
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new ClearfolioConfigurationError(
      'clearfolio_url_invalid',
      'CLEARFOLIO_URL must use HTTP or HTTPS.',
    );
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new ClearfolioConfigurationError(
      'clearfolio_transport_insecure',
      'Clearfolio production traffic requires HTTPS.',
    );
  }
  if (!CF_SECRET.trim()) {
    throw new ClearfolioConfigurationError(
      'clearfolio_hmac_secret_missing',
      'CLEARFOLIO_HMAC_SECRET is required for production tenant claims.',
    );
  }
  return { mock: false, baseUrl: url.toString().replace(/\/$/, ''), secret: CF_SECRET };
}

// Clearfolio TenantAccessService.signClaims와 동일한 규격:
// payload = tenantId \n subjectId \n permissions \n issuedAt(epoch초),
// HMAC-SHA256 → base64url(무패딩).
export function signClaims(tenantId, subjectId, permissions, issuedAt, secret) {
  const payload = [tenantId, subjectId, permissions, issuedAt].join('\n');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Build signed tenant headers for a production request.
 * @param {string|number} orgId ScopeWeave organization ID
 * @param {string|number} userId ScopeWeave user ID
 * @param {string} secret shared HMAC secret
 * @returns {Record<string, string>}
 */
function tenantHeaders(orgId, userId, secret) {
  const tenantId = `sw-org-${orgId}`;
  const subjectId = `sw-user-${userId}`;
  const issuedAt = String(Math.floor(Date.now() / 1000));
  return {
    'X-Clearfolio-Tenant-Id': tenantId,
    'X-Clearfolio-Subject-Id': subjectId,
    'X-Clearfolio-Permissions': PERMISSIONS,
    'X-Clearfolio-Claims-Issued-At': issuedAt,
    'X-Clearfolio-Claims-Signature': signClaims(
      tenantId,
      subjectId,
      PERMISSIONS,
      issuedAt,
      secret,
    ),
  };
}

/**
 * Parse one provider response without leaking its body in errors.
 * @param {Response} response provider response
 * @returns {Promise<Record<string, unknown>>}
 */
async function responseJson(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ClearfolioConfigurationError(
      'clearfolio_response_invalid',
      'Clearfolio returned a non-JSON response.',
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ClearfolioConfigurationError(
      'clearfolio_response_invalid',
      'Clearfolio returned an invalid response object.',
    );
  }
  return data;
}

/**
 * Execute one bounded provider request.
 * @param {string} url provider URL
 * @param {RequestInit} init request options
 * @returns {Promise<Response>}
 */
async function providerFetch(url, init) {
  if (typeof globalThis.fetch !== 'function') {
    throw new ClearfolioConfigurationError(
      'clearfolio_transport_unavailable',
      'Clearfolio HTTP transport is unavailable.',
    );
  }
  try {
    return await globalThis.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(CLEARFOLIO_TIMEOUT_MS),
    });
  } catch {
    throw new ClearfolioConfigurationError(
      'clearfolio_provider_unavailable',
      'Clearfolio could not be reached.',
    );
  }
}

// ---- explicit dev-only store (restarts discard it) ----
const mockDocs = new Map(); // jobId -> { name, mime, bytes }
let mockSeq = 0;
export const mockArtifact = (jobId) => (clearfolioMock ? mockDocs.get(jobId) || null : null);

/**
 * Submit a conversion job to the real provider or explicit development adapter.
 * @param {string|number} orgId organization ID
 * @param {string|number} userId user ID
 * @param {{name: string, mime: string, bytes: Uint8Array|Buffer|ArrayBuffer}} document document payload
 * @returns {Promise<{jobId: string, status: string}>}
 */
export async function submitJob(orgId, userId, { name, mime, bytes }) {
  const configuration = clearfolioConfiguration();
  const size = bytes?.byteLength;
  if (!Number.isSafeInteger(size) || size <= 0 || size > CLEARFOLIO_MAX_UPLOAD_BYTES) {
    throw new ClearfolioConfigurationError(
      'clearfolio_document_size_invalid',
      'Clearfolio document size is outside the accepted boundary.',
    );
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 255) {
    throw new ClearfolioConfigurationError(
      'clearfolio_document_name_invalid',
      'Clearfolio document name is invalid.',
    );
  }
  if (configuration.mock) {
    const jobId = `mockcf-${++mockSeq}`;
    mockDocs.set(jobId, { name, mime, bytes });
    return { jobId, status: 'SUCCEEDED' };
  }

  const form = new FormData();
  form.append(
    'file',
    new Blob([bytes], { type: mime || 'application/octet-stream' }),
    name,
  );
  const response = await providerFetch(`${configuration.baseUrl}/api/v1/convert/jobs`, {
    method: 'POST',
    headers: tenantHeaders(orgId, userId, configuration.secret),
    body: form,
  });
  const data = await responseJson(response);
  if (!response.ok || typeof data.jobId !== 'string' || !data.jobId) {
    throw new ClearfolioConfigurationError(
      'clearfolio_submit_rejected',
      `Clearfolio rejected the conversion request with HTTP ${response.status}.`,
    );
  }
  return {
    jobId: data.jobId,
    status: typeof data.status === 'string' ? data.status : 'PENDING',
  };
}

/**
 * Read a conversion job's provider-authoritative status.
 * @param {string|number} orgId organization ID
 * @param {string|number} userId user ID
 * @param {string} jobId provider job ID
 * @returns {Promise<string>}
 */
export async function jobStatus(orgId, userId, jobId) {
  const configuration = clearfolioConfiguration();
  if (configuration.mock) return mockDocs.has(jobId) ? 'SUCCEEDED' : 'FAILED';
  const response = await providerFetch(
    `${configuration.baseUrl}/api/v1/convert/jobs/${encodeURIComponent(jobId)}`,
    { headers: tenantHeaders(orgId, userId, configuration.secret) },
  );
  const data = await responseJson(response);
  if (!response.ok || typeof data.status !== 'string' || !data.status) {
    throw new ClearfolioConfigurationError(
      'clearfolio_status_rejected',
      `Clearfolio rejected the status request with HTTP ${response.status}.`,
    );
  }
  return data.status;
}

/**
 * Issue a trusted HTTPS viewer URL for a completed job.
 * @param {string|number} orgId organization ID
 * @param {string|number} userId user ID
 * @param {string} jobId provider job ID
 * @returns {Promise<string>}
 */
export async function artifactUrl(orgId, userId, jobId) {
  const configuration = clearfolioConfiguration();
  if (configuration.mock) return `/api/mock-clearfolio/${encodeURIComponent(jobId)}`;
  const response = await providerFetch(
    `${configuration.baseUrl}/api/v1/viewer/${encodeURIComponent(jobId)}/artifact-links`,
    {
      method: 'POST',
      headers: tenantHeaders(orgId, userId, configuration.secret),
    },
  );
  const data = await responseJson(response);
  const link = data.artifactUrl || data.url || data.signedUrl;
  if (!response.ok || typeof link !== 'string' || !link) {
    throw new ClearfolioConfigurationError(
      'clearfolio_artifact_rejected',
      `Clearfolio rejected the artifact request with HTTP ${response.status}.`,
    );
  }
  let artifact;
  try {
    artifact = new URL(link, configuration.baseUrl);
  } catch {
    throw new ClearfolioConfigurationError(
      'clearfolio_artifact_url_invalid',
      'Clearfolio returned an invalid artifact URL.',
    );
  }
  if (artifact.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(artifact.hostname)) {
    throw new ClearfolioConfigurationError(
      'clearfolio_artifact_url_insecure',
      'Clearfolio artifact URLs must use HTTPS.',
    );
  }
  const token = artifact.searchParams.get('artifactToken');
  if (token && artifact.origin === new URL(configuration.baseUrl).origin) {
    return `${configuration.baseUrl}/viewer/${encodeURIComponent(jobId)}?artifactToken=${encodeURIComponent(token)}`;
  }
  return artifact.toString();
}
