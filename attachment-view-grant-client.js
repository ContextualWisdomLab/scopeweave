const ATTACHMENT_VIEW_PATH = /^\/api\/projects\/(\d+)\/attachments\/(\d+)\/view$/;
const GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EXCHANGE_ERROR_MESSAGE = '산출물 열람 권한을 발급하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.';
const POPUP_ERROR_MESSAGE = '산출물을 열려면 이 사이트의 팝업을 허용한 뒤 다시 시도해 주세요.';

/**
 * Recognize the legacy same-origin attachment-view URL before it reaches the
 * browser network stack. The returned session credential is used only as an
 * Authorization header for the exchange request and is never navigated.
 *
 * @param {string|URL} rawUrl Candidate URL passed to window.open().
 * @param {string} origin Trusted ScopeWeave origin.
 * @returns {{projectId: string, attachmentId: string, token: string}|null}
 */
export function parseLegacyAttachmentViewUrl(rawUrl, origin) {
  let url;
  try {
    url = new URL(String(rawUrl), origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = ATTACHMENT_VIEW_PATH.exec(url.pathname);
  if (!match || !url.searchParams.has('token') || url.searchParams.has('grant')) return null;
  return {
    projectId: match[1],
    attachmentId: match[2],
    token: url.searchParams.get('token') || '',
  };
}

/**
 * Build a scope-limited window.open bridge for legacy attachment-view calls.
 *
 * Unrelated URLs are delegated byte-for-byte to the native opener. A matching
 * attachment URL opens a blank tab synchronously, exchanges its session/PAT
 * credential through an Authorization header, and navigates only after a
 * one-time resource-bound grant is returned. This preserves popup semantics
 * while preventing the broad credential from entering browser history,
 * referrers, request URLs, or downstream provider redirects.
 *
 * @param {object} dependencies Browser capability adapters.
 * @param {string} dependencies.origin Current trusted origin.
 * @param {Function} dependencies.nativeOpen Bound native window.open().
 * @param {Function} dependencies.fetchImpl Same-origin fetch implementation.
 * @param {Function} dependencies.notify Customer-visible failure notifier.
 * @returns {Function} Replacement window.open implementation.
 */
export function createAttachmentViewOpenBridge({ origin, nativeOpen, fetchImpl, notify }) {
  if (!origin || typeof nativeOpen !== 'function' || typeof fetchImpl !== 'function' || typeof notify !== 'function') {
    throw new TypeError('attachment-view grant bridge requires origin, nativeOpen, fetchImpl, and notify');
  }

  return function openWithAttachmentGrant(rawUrl, target, features) {
    const parsed = parseLegacyAttachmentViewUrl(rawUrl, origin);
    if (!parsed) return nativeOpen(rawUrl, target, features);
    if (!parsed.token) {
      notify(EXCHANGE_ERROR_MESSAGE);
      return null;
    }

    const popup = nativeOpen('about:blank', target, features);
    if (!popup) {
      notify(POPUP_ERROR_MESSAGE);
      return null;
    }
    try {
      popup.opener = null;
    } catch {
      // Some browser/window mocks expose a read-only opener; noopener remains
      // requested by the original caller and the grant still remains scoped.
    }

    void (async () => {
      try {
        const response = await fetchImpl(`/api/projects/${parsed.projectId}/access-grants`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${parsed.token}`,
            'content-type': 'application/json',
          },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({
            purpose: 'attachment_view',
            attachmentId: parsed.attachmentId,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !GRANT_PATTERN.test(payload.grant || '')) {
          throw new Error('attachment_grant_exchange_failed');
        }
        if (popup.closed) return;
        const destination = `/api/projects/${parsed.projectId}/attachments/${parsed.attachmentId}/view?grant=${encodeURIComponent(payload.grant)}`;
        popup.location.replace(destination);
      } catch {
        try {
          popup.close();
        } catch {
          // Closing a cross-process popup can fail after browser teardown.
        }
        notify(EXCHANGE_ERROR_MESSAGE);
      }
    })();
    return popup;
  };
}

function browserNotifier(windowRef, message) {
  const toast = windowRef.document?.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  windowRef.setTimeout(() => toast.classList.remove('show'), 3500);
}

/**
 * Install the grant bridge exactly around window.open while leaving every
 * unrelated navigation delegated to the native implementation.
 *
 * @param {Window} windowRef Browser window to protect.
 * @returns {Function} Restorer used by deterministic tests and hot reloads.
 */
export function installAttachmentViewGrantBridge(windowRef) {
  if (!windowRef || typeof windowRef.open !== 'function' || typeof windowRef.fetch !== 'function') {
    throw new TypeError('attachment-view grant bridge requires a browser window');
  }
  const nativeOpen = windowRef.open.bind(windowRef);
  windowRef.open = createAttachmentViewOpenBridge({
    origin: windowRef.location.origin,
    nativeOpen,
    fetchImpl: windowRef.fetch.bind(windowRef),
    notify: (message) => browserNotifier(windowRef, message),
  });
  return () => {
    windowRef.open = nativeOpen;
  };
}

if (typeof window !== 'undefined') {
  installAttachmentViewGrantBridge(window);
}
