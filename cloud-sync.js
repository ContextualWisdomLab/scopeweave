// Security envelope for the existing cloud client. The established planner
// implementation remains in cloud-sync-core.js; this module preserves its
// exports while preventing broad session JWTs from becoming browser URL
// credentials during the staged attachment-view and realtime migrations in #413.
import { installStreamGrantEventSource } from './stream-access-grant.js';
export * from './cloud-sync-core.js';

const ATTACHMENT_VIEW_PATH = /^\/api\/projects\/([1-9][0-9]*)\/attachments\/([1-9][0-9]*)\/view$/;
const GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const patchedWindows = new WeakSet();

function normalizedOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Parse only ScopeWeave's legacy same-origin attachment-view URL shape.
 *
 * The returned session token is used solely as an Authorization header during
 * the exchange and must never be navigated, logged, or copied into a new URL.
 *
 * @param {unknown} value Candidate URL passed to window.open().
 * @param {string} origin Trusted current-page origin.
 * @returns {{projectId:string,attachmentId:string,sessionToken:string}|null} Bound exchange input.
 */
export function parseLegacyAttachmentViewUrl(value, origin) {
  if (typeof value !== 'string') return null;
  const trustedOrigin = normalizedOrigin(origin);
  if (!trustedOrigin) return null;
  let url;
  try {
    url = new URL(value, trustedOrigin);
  } catch {
    return null;
  }
  if (url.origin !== trustedOrigin || url.hash || url.searchParams.getAll('token').length !== 1) return null;
  if (url.searchParams.has('grant') || [...url.searchParams.keys()].some((key) => key !== 'token')) return null;
  const match = ATTACHMENT_VIEW_PATH.exec(url.pathname);
  const sessionToken = url.searchParams.get('token') || '';
  if (!match || !sessionToken) return null;
  return Object.freeze({ projectId: match[1], attachmentId: match[2], sessionToken });
}

function validateIssuedGrantUrl(value, origin, projectId, attachmentId) {
  if (typeof value !== 'string') throw new Error('attachment view grant response invalid');
  const trustedOrigin = normalizedOrigin(origin);
  if (!trustedOrigin) throw new Error('attachment view grant response invalid');
  let url;
  try {
    url = new URL(value, trustedOrigin);
  } catch {
    throw new Error('attachment view grant response invalid');
  }
  const expectedPath = `/api/projects/${projectId}/attachments/${attachmentId}/view`;
  const grants = url.searchParams.getAll('grant');
  if (
    url.origin !== trustedOrigin
    || url.pathname !== expectedPath
    || url.hash
    || grants.length !== 1
    || !GRANT_PATTERN.test(grants[0])
    || [...url.searchParams.keys()].some((key) => key !== 'grant')
  ) {
    throw new Error('attachment view grant response invalid');
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Exchange a broad authenticated session for one short-lived attachment grant.
 *
 * @param {object} input Resource/session inputs captured before navigation.
 * @param {string} input.projectId Project row identifier.
 * @param {string} input.attachmentId Attachment row identifier.
 * @param {string} input.sessionToken Existing ScopeWeave session or PAT secret.
 * @param {string} input.origin Trusted current-page origin.
 * @param {Function} [input.fetchImpl] Fetch-compatible transport for tests/browsers.
 * @returns {Promise<{url:string,grantId:string,expiresAtMs:number}>} Validated same-origin one-time view target.
 */
export async function exchangeAttachmentViewGrant({
  projectId,
  attachmentId,
  sessionToken,
  origin,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function' || !sessionToken) throw new Error('attachment view grant exchange unavailable');
  const response = await fetchImpl(`/api/projects/${projectId}/access-grants`, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ purpose: 'attachment_view', attachmentId }),
  });
  if (!response || response.status !== 201) throw new Error('attachment view grant exchange failed');
  const payload = await response.json().catch(() => null);
  if (
    !payload
    || typeof payload !== 'object'
    || payload.purpose !== 'attachment_view'
    || typeof payload.grantId !== 'string'
    || !Number.isSafeInteger(payload.expiresAtMs)
  ) {
    throw new Error('attachment view grant response invalid');
  }
  const url = validateIssuedGrantUrl(payload.url, origin, projectId, attachmentId);
  return Object.freeze({ url, grantId: payload.grantId, expiresAtMs: payload.expiresAtMs });
}

function popupFeaturesWithoutOpenerIsolation(features) {
  if (typeof features !== 'string' || !features.trim()) return '';
  return features
    .split(',')
    .map((feature) => feature.trim())
    .filter((feature) => feature && !/^(?:noopener|noreferrer)(?:=|$)/i.test(feature))
    .join(',');
}

/**
 * Install the attachment-view navigation bridge on one browser window.
 *
 * Only the exact legacy ScopeWeave attachment URL is intercepted. A blank
 * same-origin tab is opened synchronously to preserve the user's popup gesture,
 * its opener is severed immediately, and only the validated one-time grant URL
 * is navigated after the authenticated exchange succeeds.
 *
 * @param {Window|object} windowLike Browser window or a deterministic test seam.
 * @param {object} [options] Optional transport/notification seams.
 * @param {Function} [options.fetchImpl] Fetch-compatible grant exchange transport.
 * @param {Function} [options.alertImpl] Customer-action notification function.
 * @returns {boolean} True when newly installed; false when unsupported/already installed.
 */
export function installAttachmentViewGrantWindowOpen(windowLike, {
  fetchImpl = globalThis.fetch,
  alertImpl = typeof windowLike?.alert === 'function' ? windowLike.alert.bind(windowLike) : () => {},
} = {}) {
  if (!windowLike || typeof windowLike.open !== 'function' || patchedWindows.has(windowLike)) return false;
  const nativeOpen = windowLike.open.bind(windowLike);
  const origin = windowLike.location?.origin;

  windowLike.open = function scopeWeaveSecureOpen(value, target, features) {
    const parsed = parseLegacyAttachmentViewUrl(value, origin);
    if (!parsed) return nativeOpen(value, target, features);

    const popup = nativeOpen('about:blank', target || '_blank', popupFeaturesWithoutOpenerIsolation(features));
    if (!popup) {
      alertImpl('문서 창을 열 수 없습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 시도해 주세요.');
      return null;
    }
    try { popup.opener = null; } catch { /* cross-window hardening is best effort before navigation */ }

    exchangeAttachmentViewGrant({ ...parsed, origin, fetchImpl })
      .then(({ url }) => {
        if (!popup.closed) popup.location.replace(url);
      })
      .catch(() => {
        try { popup.close(); } catch { /* already inaccessible/closed */ }
        alertImpl('문서 열람 권한을 발급하지 못했습니다. 다시 시도해 주세요.');
      });
    return popup;
  };
  patchedWindows.add(windowLike);
  return true;
}

if (typeof window !== 'undefined') {
  // Install before app boot calls cloud-sync-core's subscribe(). The realtime
  // compatibility bridge consumes the legacy token-bearing constructor string
  // locally and never sends that broad credential over HTTP.
  installStreamGrantEventSource(window);
  installAttachmentViewGrantWindowOpen(window);
}
