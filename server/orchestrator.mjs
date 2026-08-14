// contextual-orchestrator client. Production requires an authenticated endpoint;
// deterministic responses exist only under the explicit SCOPEWEAVE_DEV=1 boundary.
const OC_URL = (process.env.ORCHESTRATOR_URL || '').replace(/\/$/, '');
const OC_TOKEN = process.env.ORCHESTRATOR_TOKEN || '';
const OC_MODEL = process.env.ORCHESTRATOR_MODEL || 'contextual-orchestrator';
const ORCHESTRATOR_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_COUNT = 256;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

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
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
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
  return { mock: false, baseUrl: url.toString().replace(/\/$/, ''), token: OC_TOKEN };
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
 * Parse one bounded provider response without returning raw provider payloads in failures.
 * @param {Response} response provider response
 * @returns {Promise<Record<string, unknown>>}
 */
async function responseJson(response) {
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new OrchestratorConfigurationError(
      'orchestrator_response_invalid',
      'contextual-orchestrator response could not be read.',
    );
  }
  if (bytes.length === 0 || bytes.length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new OrchestratorConfigurationError(
      'orchestrator_response_size_invalid',
      'contextual-orchestrator response size is outside the accepted boundary.',
    );
  }
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
      body: JSON.stringify({ model: OC_MODEL, messages: safeMessages }),
      signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
    });
  } catch {
    throw new OrchestratorConfigurationError(
      'orchestrator_provider_unavailable',
      'contextual-orchestrator could not be reached.',
    );
  }
  const data = await responseJson(response);
  const content = data?.choices?.[0]?.message?.content;
  if (!response.ok) {
    throw new OrchestratorConfigurationError(
      'orchestrator_provider_rejected',
      `contextual-orchestrator rejected the request with HTTP ${response.status}.`,
    );
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new OrchestratorConfigurationError(
      'orchestrator_response_invalid',
      'contextual-orchestrator returned no assistant content.',
    );
  }
  return content;
}
