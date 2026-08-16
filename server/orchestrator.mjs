// contextual-orchestrator client. Production requires an authenticated endpoint;
// deterministic responses exist only under the explicit SCOPEWEAVE_DEV=1 boundary.
const OC_URL = (process.env.ORCHESTRATOR_URL || '').replace(/\/$/, '');
const OC_TOKEN = process.env.ORCHESTRATOR_TOKEN || '';
const OC_MODEL = process.env.ORCHESTRATOR_MODEL || 'contextual-orchestrator';
const ORCHESTRATOR_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_COUNT = 256;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
// WHATWG URL serializes an IPv6 hostname with brackets (`[::1]`).
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export const orchestratorMock = process.env.SCOPEWEAVE_DEV === '1' && !OC_URL;

/** Stable provider-boundary failure for AI briefing requests. */
export class OrchestratorConfigurationError extends Error {
  /**
   * Create one operator-safe orchestrator error.
   * @param {string} code machine-readable failure code
   * @param {string} message operator-safe detail
   */
  constructor(code, message) {
    super(message);
    this.name = 'OrchestratorConfigurationError';
    this.code = code;
  }
}

/**
 * Resolve explicit development mode or a complete authenticated production endpoint.
 *
 * The provider setting is an origin, not an arbitrary request URL. Rejecting
 * credentials and additional URL components keeps endpoint authority separate
 * from the bearer token and prevents operator-supplied path/query/fragment data
 * from changing the fixed OpenAI-compatible request path.
 *
 * @returns {{mock: true} | {mock: false, baseUrl: string, token: string}}
 */
function orchestratorConfiguration() {
  if (orchestratorMock) return { mock: true };
  if (!OC_URL) {
    throw new OrchestratorConfigurationError(
      'orchestrator_not_configured',
      'contextual-orchestrator is unavailable because ORCHESTRATOR_URL is not configured.',
    );
  }
  let url;
  try {
    url = new URL(OC_URL);
  } catch {
    throw new OrchestratorConfigurationError(
      'orchestrator_url_invalid',
      'ORCHESTRATOR_URL must be a valid absolute URL.',
    );
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new OrchestratorConfigurationError(
      'orchestrator_url_invalid',
      'ORCHESTRATOR_URL must use HTTP or HTTPS.',
    );
  }
  if (url.username || url.password) {
    throw new OrchestratorConfigurationError(
      'orchestrator_url_credentials_forbidden',
      'ORCHESTRATOR_URL must not contain credentials.',
    );
  }
  if (url.pathname !== '/') {
    throw new OrchestratorConfigurationError(
      'orchestrator_url_path_forbidden',
      'ORCHESTRATOR_URL must identify the provider origin without a path.',
    );
  }
  if (url.search) {
    throw new OrchestratorConfigurationError(
      'orchestrator_url_query_forbidden',
      'ORCHESTRATOR_URL must not contain a query string.',
    );
  }
  if (url.hash) {
    throw new OrchestratorConfigurationError(
      'orchestrator_url_fragment_forbidden',
      'ORCHESTRATOR_URL must not contain a fragment.',
    );
  }
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new OrchestratorConfigurationError(
      'orchestrator_transport_insecure',
      'contextual-orchestrator production traffic requires HTTPS.',
    );
  }
  if (!OC_TOKEN.trim()) {
    throw new OrchestratorConfigurationError(
      'orchestrator_token_missing',
      'ORCHESTRATOR_TOKEN is required for production requests.',
    );
  }
  return { mock: false, baseUrl: url.origin, token: OC_TOKEN };
}

/**
 * Validate and copy OpenAI-compatible messages without accepting unbounded content.
 * @param {unknown} messages candidate conversation
 * @returns {{role: string, content: string}[]}
 */
function validatedMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGE_COUNT) {
    throw new OrchestratorConfigurationError(
      'orchestrator_messages_invalid',
      'Orchestrator messages must be a non-empty bounded array.',
    );
  }
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new OrchestratorConfigurationError(
        'orchestrator_message_invalid',
        'Each orchestrator message must be an object.',
      );
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) {
      throw new OrchestratorConfigurationError(
        'orchestrator_message_role_invalid',
        'Orchestrator message role is unsupported.',
      );
    }
    if (
      typeof message.content !== 'string'
      || message.content.length === 0
      || message.content.length > MAX_CONTENT_LENGTH
    ) {
      throw new OrchestratorConfigurationError(
        'orchestrator_message_content_invalid',
        'Orchestrator message content is outside the accepted boundary.',
      );
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * Build the stable response-size failure used by declared and streamed limits.
 * @returns {OrchestratorConfigurationError} Operator-safe size error.
 */
function responseSizeError() {
  return new OrchestratorConfigurationError(
    'orchestrator_response_size_invalid',
    'contextual-orchestrator response size is outside the accepted boundary.',
  );
}

/**
 * Read one provider body without ever buffering more than the configured limit.
 *
 * A trustworthy numeric Content-Length can reject an oversized response before
 * body allocation. The stream reader remains authoritative because providers
 * may omit or misstate that header. The reader is cancelled as soon as the
 * accumulated byte count exceeds the limit.
 *
 * @param {Response} response provider response
 * @returns {Promise<Buffer>} Non-empty bounded response bytes.
 */
async function boundedResponseBytes(response) {
  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength !== null && declaredLength !== undefined && declaredLength !== '') {
    const normalizedLength = String(declaredLength).trim();
    if (!/^\d+$/.test(normalizedLength)) {
      throw new OrchestratorConfigurationError(
        'orchestrator_response_invalid',
        'contextual-orchestrator returned an invalid response length.',
      );
    }
    const length = Number(normalizedLength);
    if (!Number.isSafeInteger(length)) throw responseSizeError();
    if (length === 0 || length > MAX_PROVIDER_RESPONSE_BYTES) throw responseSizeError();
  }

  const reader = response.body?.getReader?.();
  if (!reader || typeof reader.read !== 'function') {
    throw new OrchestratorConfigurationError(
      'orchestrator_response_invalid',
      'contextual-orchestrator response body is not stream-readable.',
    );
  }

  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new OrchestratorConfigurationError(
          'orchestrator_response_invalid',
          'contextual-orchestrator returned an invalid response chunk.',
        );
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best effort after the byte budget has already failed closed.
        }
        throw responseSizeError();
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof OrchestratorConfigurationError) throw error;
    throw new OrchestratorConfigurationError(
      'orchestrator_response_invalid',
      'contextual-orchestrator response could not be read.',
    );
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Releasing a consumed/cancelled reader is cleanup only and cannot alter the result.
    }
  }

  if (totalBytes === 0) throw responseSizeError();
  return Buffer.concat(chunks, totalBytes);
}

/**
 * Parse one bounded provider response without returning raw provider payloads in failures.
 * @param {Response} response provider response
 * @returns {Promise<Record<string, unknown>>}
 */
async function responseJson(response) {
  const bytes = await boundedResponseBytes(response);
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new OrchestratorConfigurationError(
      'orchestrator_response_invalid',
      'contextual-orchestrator returned a non-JSON response.',
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new OrchestratorConfigurationError(
      'orchestrator_response_invalid',
      'contextual-orchestrator returned an invalid response object.',
    );
  }
  return data;
}

/**
 * Cancel an unread non-success provider response before returning a fixed rejection.
 *
 * Undici-backed fetch bodies must be consumed or cancelled for predictable
 * connection reuse. Cancellation failures remain private cleanup details and
 * never replace the stable provider-rejection classification.
 *
 * @param {Response} response rejected provider response
 * @returns {Promise<never>}
 */
async function rejectProviderResponse(response) {
  try {
    if (response?.body && typeof response.body.cancel === 'function') {
      await response.body.cancel();
    }
  } catch {
    // Provider rejection remains authoritative even if cleanup fails.
  }
  throw new OrchestratorConfigurationError(
    'orchestrator_provider_rejected',
    `contextual-orchestrator rejected the request with HTTP ${response.status}.`,
  );
}

/**
 * Generate one AI briefing through contextual-orchestrator.
 * @param {unknown} messages OpenAI-compatible messages
 * @returns {Promise<string>}
 */
export async function chat(messages) {
  const configuration = orchestratorConfiguration();
  const safeMessages = validatedMessages(messages);
  if (configuration.mock) {
    const user = safeMessages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');
    return `[dev-orchestrator] 분석 요약: ${user.slice(0, 120)}…에 대한 개발 응답입니다. `
      + '리스크: 지연 작업을 우선 점검하세요. 권고: 임계경로 작업의 담당자 부하를 재배분하세요.';
  }
  if (typeof globalThis.fetch !== 'function') {
    throw new OrchestratorConfigurationError(
      'orchestrator_transport_unavailable',
      'Orchestrator HTTP transport is unavailable.',
    );
  }

  let response;
  try {
    response = await globalThis.fetch(`${configuration.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${configuration.token}`,
      },
      body: JSON.stringify({
        model: OC_MODEL,
        orchestration_mode: 'auto',
        messages: safeMessages,
      }),
      signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
    });
  } catch {
    throw new OrchestratorConfigurationError(
      'orchestrator_provider_unavailable',
      'contextual-orchestrator could not be reached.',
    );
  }
  if (!response.ok) return rejectProviderResponse(response);
  const data = await responseJson(response);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new OrchestratorConfigurationError(
      'orchestrator_response_invalid',
      'contextual-orchestrator returned no assistant content.',
    );
  }
  return content;
}
