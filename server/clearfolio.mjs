// Clearfolio(통합 문서 뷰어) 클라이언트 — 산출물 첨부 변환/열람 프록시.
// Production never substitutes an absent provider with successful fake conversions.
// The in-memory adapter exists only behind the explicit SCOPEWEAVE_DEV=1 boundary.
import { createHmac } from 'node:crypto';

const CF_URL_INPUT = String(process.env.CLEARFOLIO_URL || '').trim();
const CF_SECRET = String(process.env.CLEARFOLIO_HMAC_SECRET || '');
const PERMISSIONS = 'job:create,job:read,viewer:read,artifact-link:create';
const CLEARFOLIO_JOB_STATUSES = new Set(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']);
const MIN_HMAC_SECRET_LENGTH = 32;
// WHATWG URL serializes an IPv6 hostname with brackets (`[::1]`).
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 255;
const MAX_JOB_ID_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** Hard total-request budget for each Clearfolio provider call. */
export const CLEARFOLIO_REQUEST_TIMEOUT_MS = 15_000;

/** Maximum successful Clearfolio JSON response bytes read into memory. */
export const CLEARFOLIO_MAX_RESPONSE_BYTES = 256 * 1024;

/** Whether the process uses the explicit in-memory Clearfolio development adapter. */
export const clearfolioMock = process.env.SCOPEWEAVE_DEV === '1' && !CF_URL_INPUT;

/** Stable configuration error whose message is safe for browser/operator surfaces. */
export class ClearfolioConfigurationError extends Error {
  /**
   * Create a machine-classifiable Clearfolio configuration failure.
   *
   * @param {string} code - Stable failure code for tests and operator handling.
   * @param {string} message - Non-secret, non-provider diagnostic message.
   */
  constructor(code, message) {
    super(message);
    this.name = 'ClearfolioConfigurationError';
    this.code = code;
  }
}

/**
 * Resolve a safe Clearfolio runtime configuration.
 *
 * Production requires a root HTTPS origin and a non-trivial HMAC secret. HTTP
 * loopback is available only in explicit development mode. Credentials,
 * fragments, query strings, and configured URL paths are rejected so every
 * request path is constructed by this adapter rather than inherited from
 * operator input.
 *
 * @returns {{mock:true}|{mock:false,baseUrl:string,secret:string}} Runtime configuration.
 * @throws {ClearfolioConfigurationError} If production configuration is incomplete or unsafe.
 */
function clearfolioConfiguration() {
  if (clearfolioMock) return { mock: true };
  if (!CF_URL_INPUT) {
    throw new ClearfolioConfigurationError(
      'clearfolio_not_configured',
      'Clearfolio is unavailable because CLEARFOLIO_URL is not configured.',
    );
  }

  let url;
  try {
    url = new URL(CF_URL_INPUT);
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
  if (url.username || url.password) {
    throw new ClearfolioConfigurationError(
      'clearfolio_url_credentials_forbidden',
      'CLEARFOLIO_URL must not contain credentials.',
    );
  }
  if (url.search) {
    throw new ClearfolioConfigurationError(
      'clearfolio_url_query_forbidden',
      'CLEARFOLIO_URL must not contain a query string.',
    );
  }
  if (url.hash) {
    throw new ClearfolioConfigurationError(
      'clearfolio_url_fragment_forbidden',
      'CLEARFOLIO_URL must not contain a fragment.',
    );
  }
  if (url.pathname !== '/') {
    throw new ClearfolioConfigurationError(
      'clearfolio_url_path_forbidden',
      'CLEARFOLIO_URL must identify the provider origin without a path.',
    );
  }

  const isLoopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol === 'http:' && !(process.env.SCOPEWEAVE_DEV === '1' && isLoopback)) {
    throw new ClearfolioConfigurationError(
      'clearfolio_transport_insecure',
      'Clearfolio production traffic requires HTTPS.',
    );
  }
  if (CF_SECRET.replace(/\s/g, '').length < MIN_HMAC_SECRET_LENGTH) {
    throw new ClearfolioConfigurationError(
      'clearfolio_hmac_secret_invalid',
      `CLEARFOLIO_HMAC_SECRET must contain at least ${MIN_HMAC_SECRET_LENGTH} non-whitespace characters.`,
    );
  }

  return {
    mock: false,
    baseUrl: url.origin,
    secret: CF_SECRET,
  };
}

/**
 * Build the exact set of origins trusted to host Clearfolio artifacts.
 *
 * The configured Clearfolio origin is always trusted. Additional origins are
 * optional and must be comma-separated HTTPS origins with no credentials,
 * path, query, or fragment. Canonical URL origins preserve exact scheme, host,
 * and effective port identity while preventing string-prefix allowlist bypasses.
 *
 * @param {string} baseUrl - Validated Clearfolio provider origin.
 * @returns {Set<string>} Canonical origins accepted for artifact redirects.
 * @throws {ClearfolioConfigurationError} If the optional allowlist is malformed or unsafe.
 */
function clearfolioArtifactOrigins(baseUrl) {
  const trustedOrigins = new Set([new URL(baseUrl).origin]);
  const configuredOrigins = process.env.CLEARFOLIO_ARTIFACT_ORIGINS;
  if (configuredOrigins === undefined) return trustedOrigins;

  const entries = String(configuredOrigins).split(',');
  if (entries.some((entry) => entry.trim().length === 0)) {
    throw new ClearfolioConfigurationError(
      'clearfolio_artifact_origins_invalid',
      'CLEARFOLIO_ARTIFACT_ORIGINS must contain only comma-separated HTTPS origins.',
    );
  }

  for (const entry of entries) {
    const canonical = entry.trim();
    let url;
    try {
      url = new URL(canonical);
    } catch {
      throw new ClearfolioConfigurationError(
        'clearfolio_artifact_origins_invalid',
        'CLEARFOLIO_ARTIFACT_ORIGINS must contain only comma-separated HTTPS origins.',
      );
    }
    if (
      url.protocol !== 'https:'
      || Boolean(url.username + url.password)
      || url.pathname !== '/'
      || Boolean(url.search)
      || Boolean(url.hash)
      || (canonical !== url.origin && canonical !== `${url.origin}/`)
    ) {
      throw new ClearfolioConfigurationError(
        'clearfolio_artifact_origins_invalid',
        'CLEARFOLIO_ARTIFACT_ORIGINS must contain only comma-separated HTTPS origins.',
      );
    }
    trustedOrigins.add(url.origin);
  }
  return trustedOrigins;
}

/**
 * Return a non-secret operator action for one Clearfolio configuration failure.
 *
 * @param {string} code - Stable `ClearfolioConfigurationError` code.
 * @returns {string} A concrete remediation instruction containing no secret values.
 */
function clearfolioConfigurationAction(code) {
  if (code === 'clearfolio_not_configured') {
    return 'Set CLEARFOLIO_URL and CLEARFOLIO_HMAC_SECRET, or use SCOPEWEAVE_DEV=1 only for local development.';
  }
  if (code === 'clearfolio_hmac_secret_invalid') {
    return `Set CLEARFOLIO_HMAC_SECRET to at least ${MIN_HMAC_SECRET_LENGTH} non-whitespace characters.`;
  }
  if (code === 'clearfolio_artifact_origins_invalid') {
    return 'Set CLEARFOLIO_ARTIFACT_ORIGINS to comma-separated HTTPS origins without credentials, path, query, or fragment, or unset it.';
  }
  return 'Set CLEARFOLIO_URL to a root HTTPS origin without credentials, path, query, or fragment.';
}

/**
 * Describe whether the optional Clearfolio capability is locally ready to serve.
 *
 * This is configuration readiness only: it intentionally performs no DNS, HTTP,
 * authentication, or provider-health request, so ScopeWeave liveness cannot be
 * coupled to an optional downstream dependency. The development mock is reported
 * explicitly and never masquerades as production-provider readiness.
 *
 * @returns {{ready:boolean,mode:'provider'|'development_mock'|'unavailable',reason:string|null,action:string|null}} Safe capability state.
 */
export function clearfolioCapabilityStatus() {
  if (clearfolioMock) {
    return {
      ready: true,
      mode: 'development_mock',
      reason: null,
      action: 'Configure a Clearfolio provider before using this deployment for production document conversion.',
    };
  }
  try {
    const configuration = clearfolioConfiguration();
    clearfolioArtifactOrigins(configuration.baseUrl);
    return { ready: true, mode: 'provider', reason: null, action: null };
  } catch (error) {
    if (!(error instanceof ClearfolioConfigurationError)) throw error;
    return {
      ready: false,
      mode: 'unavailable',
      reason: error.code,
      action: clearfolioConfigurationAction(error.code),
    };
  }
}

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
 * @param {string} secret - Validated shared HMAC secret.
 * @returns {Record<string,string>} Tenant, subject, permission, and HMAC headers.
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

/**
 * Validate document metadata and bytes before allocating Blob/FormData objects.
 *
 * ScopeWeave's browser/API attachment ceiling is 10 MiB, so the provider adapter
 * never accepts a larger in-process document than the caller can legitimately
 * upload. Empty MIME is preserved as the existing application/octet-stream
 * fallback.
 *
 * @param {unknown} document - Untrusted adapter input.
 * @returns {{name:string,mime:string,bytes:Uint8Array}} Validated document input.
 * @throws {Error} If metadata or bytes are malformed or outside the bounded contract.
 */
function validateDocument(document) {
  if (!isJsonRecord(document)) throw new Error('clearfolio document invalid');
  const { name, mime, bytes } = document;
  if (
    typeof name !== 'string'
    || name.trim().length === 0
    || name.length > MAX_DOCUMENT_NAME_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(name)
    || typeof mime !== 'string'
    || mime.length > MAX_MIME_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(mime)
    || !(bytes instanceof Uint8Array)
    || bytes.byteLength > MAX_DOCUMENT_BYTES
  ) {
    throw new Error('clearfolio document invalid');
  }
  return { name, mime, bytes };
}

/**
 * Canonicalize and bound a provider job identifier before it reaches a URL.
 *
 * @param {unknown} jobId - Persisted or provider-returned job identifier.
 * @returns {string} Trimmed non-empty identifier no longer than 256 characters.
 * @throws {Error} If the identifier is unusable.
 */
function validateJobId(jobId) {
  if (typeof jobId !== 'string') throw new Error('clearfolio job id invalid');
  const canonical = jobId.trim();
  if (
    canonical.length === 0
    || canonical.length > MAX_JOB_ID_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(canonical)
  ) {
    throw new Error('clearfolio job id invalid');
  }
  return canonical;
}

/**
 * Compose caller cancellation with a hard provider budget that can be disposed.
 *
 * The returned scope stays active until the provider response body has been
 * fully validated or cancelled. Callers must dispose it in `finally` so fast
 * requests do not retain a timeout or caller-signal listener for the full budget.
 *
 * @param {AbortSignal|undefined} callerSignal - Optional upstream cancellation signal.
 * @returns {{signal:AbortSignal,dispose:()=>void}} Scoped provider cancellation contract.
 */
function providerSignal(callerSignal) {
  if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal');
  }

  const controller = new AbortController();
  const timeoutError = new DOMException('Clearfolio provider request timed out', 'TimeoutError');
  const timeoutId = setTimeout(
    controller.abort.bind(controller, timeoutError),
    CLEARFOLIO_REQUEST_TIMEOUT_MS,
  );
  timeoutId.unref();

  const abortFromCaller = controller.abort.bind(controller);
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
      if (callerSignal !== undefined) {
        callerSignal.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}

/**
 * Cancel an unread provider response body before returning a fixed rejection.
 *
 * Undici-backed fetch responses must be consumed or cancelled so rejected
 * downstream bodies cannot strand connection-pool resources. Cancellation
 * failures are deliberately hidden because the operation-level error remains
 * the authoritative, non-secret client and operator signal.
 *
 * @param {Response} response - Provider response whose payload must remain unread.
 * @param {string} errorMessage - Fixed non-secret error to throw after cancellation.
 * @returns {Promise<never>} Promise that always rejects with the fixed error.
 */
async function rejectProviderResponse(response, errorMessage) {
  try {
    if (response?.body && typeof response.body.cancel === 'function') {
      await response.body.cancel();
    }
  } catch {
    // The fixed operation-level rejection remains authoritative.
  }
  throw new Error(errorMessage);
}

/**
 * Parse one successful provider JSON response with media-type and byte bounds.
 *
 * Content-Length is treated only as an early rejection hint; the body stream is
 * independently counted so omitted or dishonest length headers cannot bypass the
 * memory ceiling. Invalid UTF-8, JSON, stream errors, and cancellation are
 * collapsed to one operation-level message.
 *
 * @param {Response} response - Successful fetch response.
 * @param {string} invalidMessage - Fixed operation-level validation error.
 * @returns {Promise<unknown>} Parsed JSON value.
 * @throws {Error} If media type, declared/streamed size, UTF-8, or JSON is invalid.
 */
async function readBoundedJson(response, invalidMessage) {
  const contentType = response?.headers?.get?.('content-type');
  if (
    typeof contentType !== 'string'
    || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
  ) {
    return rejectProviderResponse(response, invalidMessage);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return rejectProviderResponse(response, invalidMessage);
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > CLEARFOLIO_MAX_RESPONSE_BYTES) {
      return rejectProviderResponse(response, invalidMessage);
    }
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    return rejectProviderResponse(response, invalidMessage);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error(invalidMessage);
      totalBytes += value.byteLength;
      if (totalBytes > CLEARFOLIO_MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* validation remains authoritative */ }
        throw new Error(invalidMessage);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error?.message === invalidMessage) throw error;
    throw new Error(invalidMessage);
  } finally {
    try { reader.releaseLock(); } catch { /* no observable effect */ }
  }

  if (totalBytes === 0) throw new Error(invalidMessage);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(invalidMessage);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(invalidMessage);
  }
}

// ---- explicit development-only mock store (restart discards it) ----
const mockDocs = new Map(); // jobId -> { name, mime, bytes }
let mockSeq = 0;

/**
 * Read one in-memory mock artifact only when the development adapter is active.
 *
 * @param {string} jobId - Mock conversion job identifier.
 * @returns {{name:string,mime:string,bytes:Buffer}|null} Stored artifact or null.
 */
export const mockArtifact = (jobId) => (clearfolioMock ? mockDocs.get(jobId) || null : null);

/**
 * Submit a document conversion job through Clearfolio or the explicit local mock.
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
export async function submitJob(orgId, userId, document) {
  const validatedDocument = validateDocument(document);
  const configuration = clearfolioConfiguration();
  if (configuration.mock) {
    const jobId = `mockcf-${++mockSeq}`;
    mockDocs.set(jobId, validatedDocument);
    return { jobId, status: 'SUCCEEDED' };
  }
  const form = new FormData();
  form.append(
    'file',
    new Blob([validatedDocument.bytes], { type: validatedDocument.mime || 'application/octet-stream' }),
    validatedDocument.name,
  );
  const request = providerSignal();
  try {
    let res;
    try {
      res = await fetch(`${configuration.baseUrl}/api/v1/convert/jobs`, {
        method: 'POST',
        headers: tenantHeaders(orgId, userId, configuration.secret),
        body: form,
        redirect: 'error',
        signal: request.signal,
      });
    } catch {
      throw new Error('clearfolio submit unavailable');
    }
    if (!res.ok) return rejectProviderResponse(res, `clearfolio submit failed (${res.status})`);
    const data = await readBoundedJson(res, 'clearfolio submit response invalid');
    if (!isJsonRecord(data)) throw new Error('clearfolio submit response invalid');
    const status = data.status === undefined ? 'PENDING' : data.status;
    if (typeof data.jobId !== 'string' || !isClearfolioJobStatus(status)) {
      throw new Error('clearfolio submit response invalid');
    }
    let jobId;
    try {
      jobId = validateJobId(data.jobId);
    } catch {
      throw new Error('clearfolio submit response invalid');
    }
    return { jobId, status };
  } finally {
    request.dispose();
  }
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
  const canonicalJobId = validateJobId(jobId);
  const configuration = clearfolioConfiguration();
  if (configuration.mock) return mockDocs.has(canonicalJobId) ? 'SUCCEEDED' : 'FAILED';
  let request;
  try {
    request = providerSignal(signal);
  } catch {
    throw new Error('clearfolio status unavailable');
  }
  try {
    let res;
    try {
      res = await fetch(`${configuration.baseUrl}/api/v1/convert/jobs/${encodeURIComponent(canonicalJobId)}`, {
        headers: tenantHeaders(orgId, userId, configuration.secret),
        signal: request.signal,
        redirect: 'error',
      });
    } catch {
      throw new Error('clearfolio status unavailable');
    }
    if (!res.ok) return rejectProviderResponse(res, `clearfolio status failed (${res.status})`);
    const data = await readBoundedJson(res, 'clearfolio status response invalid');
    if (!isJsonRecord(data) || !isClearfolioJobStatus(data.status)) {
      throw new Error('clearfolio status response invalid');
    }
    return data.status;
  } finally {
    request.dispose();
  }
}

/**
 * Issue a viewable artifact URL for a completed Clearfolio job.
 *
 * Same-origin `artifactToken` values may be translated into the local viewer
 * route. A token returned on another origin remains bound to that origin and is
 * never transplanted into the trusted Clearfolio viewer URL.
 *
 * @param {string|number} orgId - ScopeWeave organization identifier.
 * @param {string|number} userId - Requesting ScopeWeave user identifier.
 * @param {string} jobId - Completed conversion job identifier.
 * @returns {Promise<string>} Relative mock path or validated absolute artifact URL.
 * @throws {Error} If Clearfolio is unavailable, rejects the request, or returns an invalid link.
 */
export async function artifactUrl(orgId, userId, jobId) {
  const canonicalJobId = validateJobId(jobId);
  const configuration = clearfolioConfiguration();
  if (configuration.mock) return `/api/mock-clearfolio/${encodeURIComponent(canonicalJobId)}`;
  const trustedArtifactOrigins = clearfolioArtifactOrigins(configuration.baseUrl);
  const request = providerSignal();
  try {
    let res;
    try {
      res = await fetch(`${configuration.baseUrl}/api/v1/viewer/${encodeURIComponent(canonicalJobId)}/artifact-links`, {
        method: 'POST',
        headers: tenantHeaders(orgId, userId, configuration.secret),
        redirect: 'error',
        signal: request.signal,
      });
    } catch {
      throw new Error('clearfolio artifact-link unavailable');
    }
    if (!res.ok) return rejectProviderResponse(res, `clearfolio artifact-link failed (${res.status})`);
    const data = await readBoundedJson(res, 'clearfolio artifact-link response invalid');
    if (!isJsonRecord(data)) throw new Error('clearfolio artifact-link response invalid');
    const link = data.artifactUrl || data.url || data.signedUrl;
    if (typeof link !== 'string' || link.length === 0) {
      throw new Error('clearfolio artifact-link response invalid');
    }

    let url;
    let clearfolioUrl;
    try {
      clearfolioUrl = new URL(configuration.baseUrl);
      url = new URL(link, clearfolioUrl);
    } catch {
      throw new Error('clearfolio artifact-link response invalid');
    }
    const allowsHttp = clearfolioUrl.protocol === 'http:' && url.protocol === 'http:';
    if (url.protocol !== 'https:' && !allowsHttp) {
      throw new Error('clearfolio artifact-link response invalid');
    }
    if (
      Boolean(url.username + url.password)
      || Boolean(url.hash)
      || !trustedArtifactOrigins.has(url.origin)
    ) {
      throw new Error('clearfolio artifact-link response invalid');
    }

    const token = url.searchParams.get('artifactToken');
    if (token && url.origin === clearfolioUrl.origin) {
      return `${configuration.baseUrl}/viewer/${encodeURIComponent(canonicalJobId)}?artifactToken=${encodeURIComponent(token)}`;
    }
    return url.href;
  } finally {
    request.dispose();
  }
}
