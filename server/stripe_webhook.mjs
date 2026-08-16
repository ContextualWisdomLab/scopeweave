import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const STRIPE_WEBHOOK_MAX_BYTES = 256 * 1024;
const STRIPE_SIGNATURE_HEADER_MAX_LENGTH = 4096;
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const STRIPE_EVENT_FIELD_MAX_LENGTH = 255;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const DECIMAL_INTEGER_PATTERN = /^\d+$/;

/**
 * Stable, browser-safe Stripe webhook boundary failure.
 *
 * The error contains only a machine-readable classification and HTTP status;
 * signatures, webhook secrets, raw provider payloads, and parser details never
 * cross this boundary.
 */
export class StripeWebhookError extends Error {
  /**
   * Create one sanitized webhook verification failure.
   * @param {string} code stable machine-readable error code
   * @param {number} status HTTP response status for the adapter
   */
  constructor(code, status) {
    super(code);
    this.name = 'StripeWebhookError';
    this.code = code;
    this.status = status;
  }
}

function webhookError(code, status = 400) {
  return new StripeWebhookError(code, status);
}

function requireVerifierConfiguration(secret, nowSeconds) {
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw webhookError('stripe_webhook_not_configured', 503);
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw webhookError('stripe_webhook_request_invalid');
  }
}

async function readBoundedRawBody(request) {
  if (!request || typeof request !== 'object' || !request.headers) {
    throw webhookError('stripe_webhook_request_invalid');
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const normalizedLength = declaredLength.trim();
    if (!DECIMAL_INTEGER_PATTERN.test(normalizedLength)) {
      throw webhookError('stripe_webhook_request_invalid');
    }
    const length = Number(normalizedLength);
    if (!Number.isSafeInteger(length)) {
      throw webhookError('stripe_webhook_request_invalid');
    }
    if (length > STRIPE_WEBHOOK_MAX_BYTES) {
      throw webhookError('stripe_webhook_body_too_large', 413);
    }
  }

  const reader = request.body?.getReader?.();
  if (!reader || typeof reader.read !== 'function') {
    throw webhookError('stripe_webhook_request_invalid');
  }

  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      let result;
      try {
        result = await reader.read();
      } catch {
        throw webhookError('stripe_webhook_request_invalid');
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw webhookError('stripe_webhook_request_invalid');
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > STRIPE_WEBHOOK_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best effort after the byte budget has failed closed.
        }
        throw webhookError('stripe_webhook_body_too_large', 413);
      }
      chunks.push(result.value);
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Reader cleanup cannot change the verification result.
    }
  }

  const body = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    Buffer.from(chunk).copy(body, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseStripeSignatureHeader(header) {
  if (
    typeof header !== 'string'
    || header.length === 0
    || header.length > STRIPE_SIGNATURE_HEADER_MAX_LENGTH
  ) {
    throw webhookError('stripe_webhook_signature_invalid');
  }

  const timestamps = [];
  const signatures = [];
  for (const component of header.split(',')) {
    const separator = component.indexOf('=');
    if (separator <= 0) continue;
    const key = component.slice(0, separator).trim();
    const value = component.slice(separator + 1).trim();
    if (key === 't') timestamps.push(value);
    if (key === 'v1') signatures.push(value);
  }

  if (timestamps.length !== 1 || !DECIMAL_INTEGER_PATTERN.test(timestamps[0])) {
    throw webhookError('stripe_webhook_signature_invalid');
  }
  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || signatures.length === 0) {
    throw webhookError('stripe_webhook_signature_invalid');
  }

  const validSignatures = signatures.filter((signature) => HEX_SHA256_PATTERN.test(signature));
  if (validSignatures.length === 0) {
    throw webhookError('stripe_webhook_signature_invalid');
  }
  return { timestamp, signatures: validSignatures };
}

function signatureMatches(body, signatureHeader, secret, nowSeconds) {
  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);
  if (Math.abs(nowSeconds - timestamp) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(String(timestamp))
    .update('.')
    .update(body)
    .digest();

  let matched = false;
  for (const signature of signatures) {
    const candidate = Buffer.from(signature, 'hex');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      matched = true;
    }
  }
  return matched;
}

function parseVerifiedEvent(body) {
  let event;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    event = JSON.parse(text);
  } catch {
    throw webhookError('stripe_webhook_payload_invalid');
  }

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw webhookError('stripe_webhook_payload_invalid');
  }
  if (
    typeof event.id !== 'string'
    || event.id.length === 0
    || event.id.length > STRIPE_EVENT_FIELD_MAX_LENGTH
    || typeof event.type !== 'string'
    || event.type.length === 0
    || event.type.length > STRIPE_EVENT_FIELD_MAX_LENGTH
  ) {
    throw webhookError('stripe_webhook_payload_invalid');
  }
  return event;
}

/**
 * Verify and parse one Stripe webhook without mutating its signed request body.
 *
 * Stripe signs `timestamp + "." + raw request body`; JSON parsing therefore
 * happens only after constant-time HMAC verification over the exact streamed
 * bytes. The request body is capped at 256 KiB before buffering, the signature
 * header is bounded, and the signed timestamp must be within five minutes of the
 * server clock. Multiple `v1` values are accepted for endpoint-secret rotation.
 *
 * This function establishes transport authenticity only. Callers that persist
 * replay evidence can request the SHA-256 digest of those exact verified bytes;
 * the raw body itself never needs to cross into durable storage.
 *
 * @param {Request} request Fetch-compatible request containing the raw webhook body
 * @param {object} options verifier configuration
 * @param {string} options.secret Stripe endpoint signing secret
 * @param {number} [options.nowSeconds] integer epoch seconds used for replay checks
 * @param {boolean} [options.includeEvidence=false] return verified raw-byte digest with the parsed event
 * @returns {Promise<Record<string, unknown>|{event: Record<string, unknown>, payloadSha256: string}>} verified event, optionally with exact-byte digest evidence
 * @throws {StripeWebhookError} for unconfigured, oversized, malformed, or unauthenticated requests
 */
export async function verifyStripeWebhookRequest(request, {
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
  includeEvidence = false,
} = {}) {
  requireVerifierConfiguration(secret, nowSeconds);
  const body = await readBoundedRawBody(request);
  const signatureHeader = request.headers.get('stripe-signature');
  if (!signatureMatches(body, signatureHeader, secret, nowSeconds)) {
    throw webhookError('stripe_webhook_signature_invalid');
  }
  const event = parseVerifiedEvent(body);
  if (!includeEvidence) return event;
  return {
    event,
    payloadSha256: createHash('sha256').update(body).digest('hex'),
  };
}
