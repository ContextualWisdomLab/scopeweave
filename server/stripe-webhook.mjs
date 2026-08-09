import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const SUBSCRIPTION_PRO_STATUSES = new Set(['active', 'trialing', 'past_due']);
const SUBSCRIPTION_FREE_STATUSES = new Set([
  'canceled',
  'incomplete',
  'incomplete_expired',
  'paused',
  'unpaid',
]);
const ORGANIZATION_EVENT_TYPES = new Set([
  'checkout.session.async_payment_failed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.deleted',
  'customer.subscription.updated',
]);

/** Stable, operator-safe failure raised by the Stripe webhook trust boundary. */
export class StripeWebhookError extends Error {
  /**
   * Create a webhook error.
   * @param {string} code machine-readable failure code
   * @param {string} message operator-safe detail
   * @param {number} statusCode HTTP status suitable for the webhook response
   */
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'StripeWebhookError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Normalize the exact raw webhook body without accepting unbounded input.
 * @param {Buffer | Uint8Array | ArrayBuffer} rawBody exact provider request bytes
 * @returns {Buffer}
 */
function webhookBytes(rawBody) {
  let bytes;
  if (Buffer.isBuffer(rawBody)) bytes = rawBody;
  else if (rawBody instanceof Uint8Array) bytes = Buffer.from(rawBody);
  else if (rawBody instanceof ArrayBuffer) bytes = Buffer.from(rawBody);
  else {
    throw new StripeWebhookError(
      'stripe_webhook_body_invalid',
      'Stripe webhook body must be provided as exact raw bytes.',
    );
  }
  if (bytes.length === 0 || bytes.length > MAX_WEBHOOK_BYTES) {
    throw new StripeWebhookError(
      'stripe_webhook_body_size_invalid',
      'Stripe webhook body size is outside the accepted boundary.',
      413,
    );
  }
  return bytes;
}

/**
 * Parse Stripe's comma-separated signature header.
 * @param {string} signatureHeader Stripe-Signature header value
 * @returns {{timestamp: number, signatures: string[]}}
 */
function parseSignatureHeader(signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader.trim()) {
    throw new StripeWebhookError(
      'stripe_signature_missing',
      'Stripe-Signature is required.',
    );
  }
  let timestamp = null;
  const signatures = [];
  for (const component of signatureHeader.split(',')) {
    const separator = component.indexOf('=');
    if (separator <= 0) continue;
    const key = component.slice(0, separator).trim();
    const value = component.slice(separator + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-fA-F]{64}$/.test(value)) signatures.push(value.toLowerCase());
  }
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) {
    throw new StripeWebhookError(
      'stripe_signature_malformed',
      'Stripe-Signature is malformed.',
    );
  }
  return { timestamp, signatures };
}

/**
 * Verify Stripe's HMAC signature against the exact request bytes.
 * @param {{rawBody: Buffer | Uint8Array | ArrayBuffer, signatureHeader: string, webhookSecret: string, nowSeconds?: number, toleranceSeconds?: number}} input verification input
 * @returns {{timestamp: number}}
 */
export function verifyStripeSignature({
  rawBody,
  signatureHeader,
  webhookSecret,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
}) {
  const bytes = webhookBytes(rawBody);
  if (typeof webhookSecret !== 'string' || !webhookSecret.trim()) {
    throw new StripeWebhookError(
      'stripe_webhook_secret_missing',
      'Stripe webhook verification is not configured.',
      503,
    );
  }
  if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0) {
    throw new StripeWebhookError(
      'stripe_signature_clock_invalid',
      'Stripe signature clock configuration is invalid.',
      500,
    );
  }
  const parsed = parseSignatureHeader(signatureHeader);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    throw new StripeWebhookError(
      'stripe_signature_expired',
      'Stripe-Signature timestamp is outside the accepted tolerance.',
    );
  }
  const expected = createHmac('sha256', webhookSecret)
    .update(String(parsed.timestamp))
    .update('.')
    .update(bytes)
    .digest();
  const valid = parsed.signatures.some((candidate) => {
    const provided = Buffer.from(candidate, 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!valid) {
    throw new StripeWebhookError(
      'stripe_signature_invalid',
      'Stripe-Signature verification failed.',
    );
  }
  return { timestamp: parsed.timestamp };
}

/**
 * Parse a verified Stripe event into a bounded plain object.
 * @param {Buffer} bytes verified event bytes
 * @returns {Record<string, unknown>}
 */
function parseEvent(bytes) {
  let event;
  try {
    event = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new StripeWebhookError(
      'stripe_event_json_invalid',
      'Stripe webhook body is not valid JSON.',
    );
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new StripeWebhookError(
      'stripe_event_invalid',
      'Stripe webhook event is not an object.',
    );
  }
  if (typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_]{1,240}$/.test(event.id)) {
    throw new StripeWebhookError(
      'stripe_event_id_invalid',
      'Stripe webhook event ID is missing or invalid.',
    );
  }
  if (typeof event.type !== 'string' || event.type.length > 160) {
    throw new StripeWebhookError(
      'stripe_event_type_invalid',
      'Stripe webhook event type is missing or invalid.',
    );
  }
  return event;
}

/**
 * Return the event's provider object when present.
 * @param {Record<string, unknown>} event verified Stripe event
 * @returns {Record<string, unknown>}
 */
function eventObject(event) {
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const object = data.object;
  return object && typeof object === 'object' && !Array.isArray(object) ? object : {};
}

/**
 * Resolve a positive integer organization ID from provider metadata.
 * @param {Record<string, unknown>} object Stripe event object
 * @returns {number | null}
 */
function organizationIdFrom(object) {
  const metadata = object.metadata;
  const metadataOrgId = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata.orgId
    : null;
  const candidate = object.client_reference_id ?? metadataOrgId;
  const organizationId = Number(candidate);
  return Number.isSafeInteger(organizationId) && organizationId > 0
    ? organizationId
    : null;
}

/**
 * Determine the entitlement plan represented by one supported Stripe event.
 * @param {string} eventType Stripe event type
 * @param {Record<string, unknown>} object Stripe event object
 * @returns {'pro' | 'free' | null}
 */
function targetPlan(eventType, object) {
  if (eventType === 'checkout.session.async_payment_succeeded') return 'pro';
  if (eventType === 'checkout.session.async_payment_failed') return 'free';
  if (eventType === 'checkout.session.completed') {
    return ['paid', 'no_payment_required'].includes(String(object.payment_status || ''))
      ? 'pro'
      : null;
  }
  if (eventType === 'customer.subscription.deleted') return 'free';
  if (eventType === 'customer.subscription.created' || eventType === 'customer.subscription.updated') {
    const status = String(object.status || '');
    if (SUBSCRIPTION_PRO_STATUSES.has(status)) return 'pro';
    if (SUBSCRIPTION_FREE_STATUSES.has(status)) return 'free';
    throw new StripeWebhookError(
      'stripe_subscription_status_unsupported',
      'Stripe subscription status is unsupported by the entitlement policy.',
    );
  }
  return null;
}

/**
 * Create the durable idempotency ledger required by provider retries.
 * @param {import('node:sqlite').DatabaseSync} db ScopeWeave database
 */
function ensureBillingEventRecords(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_event_records (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      organization_id INTEGER,
      applied_plan TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Verify and apply one Stripe event transactionally and idempotently.
 * @param {{db: import('node:sqlite').DatabaseSync, rawBody: Buffer | Uint8Array | ArrayBuffer, signatureHeader: string, webhookSecret: string, nowSeconds?: number, toleranceSeconds?: number}} input processing input
 * @returns {{received: true, duplicate: boolean, organizationId: number | null, plan: 'pro' | 'free' | null, eventType: string}}
 */
export function processStripeWebhook({
  db,
  rawBody,
  signatureHeader,
  webhookSecret,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
}) {
  const bytes = webhookBytes(rawBody);
  verifyStripeSignature({
    rawBody: bytes,
    signatureHeader,
    webhookSecret,
    nowSeconds,
    toleranceSeconds,
  });
  const event = parseEvent(bytes);
  const object = eventObject(event);
  const requiresOrganization = ORGANIZATION_EVENT_TYPES.has(event.type);
  const organizationId = requiresOrganization ? organizationIdFrom(object) : null;
  if (requiresOrganization && organizationId == null) {
    throw new StripeWebhookError(
      'stripe_organization_metadata_missing',
      'Stripe event is missing valid organization metadata.',
    );
  }
  const plan = targetPlan(event.type, object);

  ensureBillingEventRecords(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare(
      'SELECT event_type, organization_id, applied_plan FROM billing_event_records WHERE event_id = ?'
    ).get(event.id);
    if (previous) {
      db.exec('COMMIT');
      return {
        received: true,
        duplicate: true,
        organizationId: previous.organization_id == null ? null : Number(previous.organization_id),
        plan: previous.applied_plan || null,
        eventType: previous.event_type,
      };
    }

    if (organizationId != null) {
      const organization = db.prepare('SELECT id FROM orgs WHERE id = ?').get(organizationId);
      if (!organization) {
        throw new StripeWebhookError(
          'stripe_organization_not_found',
          'Stripe event references an unknown organization.',
        );
      }
      if (plan != null) {
        db.prepare('UPDATE orgs SET plan = ? WHERE id = ?').run(plan, organizationId);
      }
    }
    db.prepare(
      'INSERT INTO billing_event_records(event_id, event_type, organization_id, applied_plan) VALUES(?,?,?,?)'
    ).run(event.id, event.type, organizationId, plan);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (error instanceof StripeWebhookError) throw error;
    throw new StripeWebhookError(
      'stripe_event_persistence_failed',
      'Stripe event could not be persisted safely.',
      500,
    );
  }

  return {
    received: true,
    duplicate: false,
    organizationId,
    plan,
    eventType: event.type,
  };
}
