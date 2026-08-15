// Short-lived, one-time stream access-grant client for ScopeWeave realtime SSE.
// Broad session credentials are used only in Authorization headers during the
// exchange and are never sent in EventSource URLs.
const GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROJECT_ID_PATTERN = /^[1-9][0-9]*$/;
const installedWindows = new WeakSet();

function normalizedOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.origin : null;
  } catch {
    return null;
  }
}

function normalizedProjectId(value) {
  const projectId = String(value ?? '');
  return PROJECT_ID_PATTERN.test(projectId) ? projectId : null;
}

/**
 * Validate the exact same-origin one-time stream grant URL issued by ScopeWeave.
 *
 * The returned value is a relative URL so callers cannot accidentally retain a
 * caller-controlled origin. Only one `grant` parameter is accepted; fragments,
 * credentials, legacy `token` parameters, and extra query keys fail closed.
 *
 * @param {unknown} value Candidate URL returned by the grant exchange.
 * @param {object} input Validation context.
 * @param {string} input.origin Trusted current-page origin.
 * @param {string|number} input.projectId Exact project row identifier.
 * @returns {string} Canonical same-origin stream URL.
 */
export function validateStreamGrantUrl(value, { origin, projectId } = {}) {
  if (typeof value !== 'string') throw new Error('stream grant url invalid');
  const trustedOrigin = normalizedOrigin(origin);
  const normalizedId = normalizedProjectId(projectId);
  if (!trustedOrigin || !normalizedId) throw new Error('stream grant url invalid');

  let url;
  try {
    url = new URL(value, trustedOrigin);
  } catch {
    throw new Error('stream grant url invalid');
  }
  const grants = url.searchParams.getAll('grant');
  const expectedPath = `/api/projects/${normalizedId}/stream`;
  if (
    url.origin !== trustedOrigin
    || url.username
    || url.password
    || url.pathname !== expectedPath
    || url.hash
    || grants.length !== 1
    || !GRANT_PATTERN.test(grants[0])
    || [...url.searchParams.keys()].some((key) => key !== 'grant')
  ) {
    throw new Error('stream grant url invalid');
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Create a resilient SSE connection that exchanges a broad session credential
 * for a fresh one-time project-bound grant before every connection attempt.
 *
 * Native EventSource reconnect cannot be used with one-time grants because it
 * would replay an already-consumed URL. On transport failure this controller
 * closes the native source, waits for the bounded retry delay, exchanges for a
 * new grant, and only then opens the replacement EventSource.
 *
 * @param {object} input Connection dependencies and callbacks.
 * @param {string|number} input.projectId Exact project row identifier.
 * @param {Function} input.getSessionToken Returns the current session/PAT secret.
 * @param {Function} [input.fetchImpl] Fetch-compatible grant exchange transport.
 * @param {Function} [input.EventSourceImpl] Native EventSource constructor.
 * @param {string} input.origin Trusted current-page origin.
 * @param {Function} [input.onMessage] Receives native SSE message events.
 * @param {Function} [input.onStatus] Receives `connecting`, `connected`, `retrying`, or `closed`.
 * @param {Function} [input.schedule] Timeout-compatible scheduler.
 * @param {Function} [input.cancelSchedule] Timeout-compatible cancellation function.
 * @param {number} [input.retryDelayMs] Reconnect delay in milliseconds.
 * @returns {{ready:Promise<void>,close:Function}} Connection lifecycle handle.
 */
export function createStreamGrantConnection({
  projectId,
  getSessionToken,
  fetchImpl = globalThis.fetch,
  EventSourceImpl = globalThis.EventSource,
  origin,
  onMessage = () => {},
  onStatus = () => {},
  schedule = globalThis.setTimeout,
  cancelSchedule = globalThis.clearTimeout,
  retryDelayMs = 1000,
} = {}) {
  const normalizedId = normalizedProjectId(projectId);
  if (
    !normalizedId
    || typeof getSessionToken !== 'function'
    || typeof fetchImpl !== 'function'
    || typeof EventSourceImpl !== 'function'
    || !normalizedOrigin(origin)
    || typeof schedule !== 'function'
    || typeof cancelSchedule !== 'function'
    || !Number.isFinite(retryDelayMs)
    || retryDelayMs < 0
  ) {
    throw new Error('stream grant connection invalid');
  }

  let stopped = false;
  let source = null;
  let retryHandle = null;
  let exchangeController = null;
  let generation = 0;
  let lastStatus = null;

  const emitStatus = (status) => {
    if (lastStatus === status) return;
    lastStatus = status;
    onStatus(status);
  };

  const scheduleRetry = () => {
    if (stopped || retryHandle !== null) return;
    if (source) {
      try { source.close(); } catch { /* already closed */ }
      source = null;
    }
    emitStatus('retrying');
    retryHandle = schedule(async () => {
      retryHandle = null;
      await connect();
    }, retryDelayMs);
  };

  const connect = async () => {
    if (stopped) return;
    const sessionToken = String(getSessionToken() || '');
    if (!sessionToken) {
      emitStatus('closed');
      return;
    }

    const attempt = ++generation;
    emitStatus('connecting');
    exchangeController?.abort();
    exchangeController = new AbortController();
    try {
      const response = await fetchImpl(`/api/projects/${normalizedId}/access-grants`, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: exchangeController.signal,
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ purpose: 'stream' }),
      });
      if (stopped || attempt !== generation) return;
      if (!response || response.status !== 201) throw new Error('stream grant exchange failed');
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload !== 'object' || payload.purpose !== 'stream') {
        throw new Error('stream grant response invalid');
      }
      const url = validateStreamGrantUrl(payload.url, { origin, projectId: normalizedId });
      if (stopped || attempt !== generation) return;

      const current = new EventSourceImpl(url);
      source = current;
      current.onopen = () => {
        if (!stopped && source === current) emitStatus('connected');
      };
      current.onmessage = (event) => {
        if (!stopped && source === current) onMessage(event);
      };
      current.onerror = () => {
        if (stopped || source !== current) return;
        try { current.close(); } catch { /* already closed */ }
        source = null;
        scheduleRetry();
      };
    } catch {
      if (!stopped && attempt === generation) scheduleRetry();
    } finally {
      if (attempt === generation) exchangeController = null;
    }
  };

  const ready = connect();
  return Object.freeze({
    ready,
    close() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      exchangeController?.abort();
      exchangeController = null;
      if (retryHandle !== null) {
        cancelSchedule(retryHandle);
        retryHandle = null;
      }
      if (source) {
        try { source.close(); } catch { /* already closed */ }
        source = null;
      }
      emitStatus('closed');
    },
  });
}

function parseLegacyStreamUrl(value, origin) {
  if (typeof value !== 'string') return null;
  const trustedOrigin = normalizedOrigin(origin);
  if (!trustedOrigin) return null;
  let url;
  try {
    url = new URL(value, trustedOrigin);
  } catch {
    return null;
  }
  const match = /^\/api\/projects\/([1-9][0-9]*)\/stream$/.exec(url.pathname);
  const tokens = url.searchParams.getAll('token');
  if (
    url.origin !== trustedOrigin
    || url.username
    || url.password
    || url.hash
    || !match
    || tokens.length !== 1
    || !tokens[0]
    || [...url.searchParams.keys()].some((key) => key !== 'token')
  ) return null;
  return Object.freeze({ projectId: match[1], sessionToken: tokens[0] });
}

/**
 * Install an EventSource compatibility bridge for ScopeWeave's legacy caller.
 *
 * `cloud-sync-core.js` still constructs `/stream?token=<session>` while this
 * staged migration remains stacked. The bridge consumes that string locally,
 * never sends it over the network, and exposes an EventSource-shaped facade
 * backed by `createStreamGrantConnection`. Non-ScopeWeave EventSource URLs are
 * passed through unchanged to the native constructor.
 *
 * @param {Window|object} windowLike Browser window or deterministic test seam.
 * @param {object} [options] Optional transport/timer seams.
 * @returns {boolean} True when newly installed; false when unsupported/already installed.
 */
export function installStreamGrantEventSource(windowLike, {
  fetchImpl = typeof windowLike?.fetch === 'function' ? windowLike.fetch.bind(windowLike) : globalThis.fetch,
  schedule = globalThis.setTimeout,
  cancelSchedule = globalThis.clearTimeout,
  retryDelayMs = 1000,
} = {}) {
  if (!windowLike || typeof windowLike.EventSource !== 'function' || installedWindows.has(windowLike)) return false;
  const NativeEventSource = windowLike.EventSource;
  const origin = windowLike.location?.origin;
  if (!normalizedOrigin(origin)) return false;

  class ScopeWeaveGrantEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor(value, init) {
      const parsed = parseLegacyStreamUrl(value, origin);
      if (!parsed) return new NativeEventSource(value, init);

      this.CONNECTING = 0;
      this.OPEN = 1;
      this.CLOSED = 2;
      this.readyState = 0;
      this.url = `/api/projects/${parsed.projectId}/stream`;
      this.withCredentials = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this._listeners = new Map();
      this._connection = createStreamGrantConnection({
        projectId: parsed.projectId,
        getSessionToken: () => parsed.sessionToken,
        fetchImpl,
        EventSourceImpl: NativeEventSource,
        origin,
        schedule,
        cancelSchedule,
        retryDelayMs,
        onMessage: (event) => this._dispatch('message', event),
        onStatus: (status) => {
          if (status === 'connected') {
            this.readyState = 1;
            this._dispatch('open', { type: 'open' });
          } else if (status === 'retrying') {
            this.readyState = 0;
            this._dispatch('error', { type: 'error' });
          } else if (status === 'closed') {
            this.readyState = 2;
          } else {
            this.readyState = 0;
          }
        },
      });
    }

    addEventListener(type, listener) {
      if (typeof listener !== 'function') return;
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
      this._listeners.get(type)?.delete(listener);
    }

    _dispatch(type, event) {
      const handler = this[`on${type}`];
      if (typeof handler === 'function') handler.call(this, event);
      for (const listener of this._listeners.get(type) || []) listener.call(this, event);
    }

    close() {
      this._connection.close();
      this.readyState = 2;
    }
  }

  windowLike.EventSource = ScopeWeaveGrantEventSource;
  installedWindows.add(windowLike);
  return true;
}
