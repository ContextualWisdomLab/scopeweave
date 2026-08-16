const MAX_EVENT_FIELD_LENGTH = 255;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAVEPOINT_NAME = 'billing_stripe_webhook_event_write';
let configuredRecorder = null;

/** Stable persistence-boundary error for verified Stripe webhook events. */
export class StripeWebhookLedgerError extends Error {
  /**
   * @param {string} code stable machine-readable failure code
   * @param {number} status HTTP status suitable for the webhook adapter
   */
  constructor(code, status) {
    super(code);
    this.name = 'StripeWebhookLedgerError';
    this.code = code;
    this.status = status;
  }
}

function ledgerError(code, status = 400) {
  return new StripeWebhookLedgerError(code, status);
}

function requiredString(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EVENT_FIELD_LENGTH) {
    throw ledgerError('stripe_webhook_event_invalid');
  }
  return value;
}

function nullableString(value) {
  if (value == null) return null;
  return requiredString(value);
}

function safeCreated(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw ledgerError('stripe_webhook_event_invalid');
  }
  return value;
}

function safeNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw ledgerError('stripe_webhook_event_invalid');
  }
  return value;
}

function normalizedPayloadHash(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw ledgerError('stripe_webhook_event_invalid');
  }
  return value.toLowerCase();
}

function normalizedRequestId(request) {
  if (request == null) return null;
  if (typeof request !== 'object' || Array.isArray(request)) {
    throw ledgerError('stripe_webhook_event_invalid');
  }
  return requiredString(request.id);
}

function normalizedEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw ledgerError('stripe_webhook_event_invalid');
  }
  const providerObject = event.data?.object;
  if (!providerObject || typeof providerObject !== 'object' || Array.isArray(providerObject)) {
    throw ledgerError('stripe_webhook_event_invalid');
  }
  const requestId = normalizedRequestId(event.request);
  return {
    eventId: requiredString(event.id),
    providerCreatedAtSec: safeCreated(event.created),
    eventType: requiredString(event.type),
    objectId: requiredString(providerObject.id),
    objectType: requiredString(providerObject.object),
    apiVersion: nullableString(event.api_version),
    requestId,
  };
}

function withSavepoint(database, operation) {
  database.exec(`SAVEPOINT ${SAVEPOINT_NAME}`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    return result;
  } catch (error) {
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
    } finally {
      database.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    }
    throw error;
  }
}

/**
 * Install the process-local verified-event recorder during database bootstrap.
 *
 * Keeping recorder installation explicit avoids database side effects in pure
 * signature-verification unit tests while ensuring the production app, which
 * imports `db.mjs` before the webhook verifier, records every authenticated event.
 *
 * @param {(input: {event: Record<string, unknown>, payloadSha256: string}) => unknown} recorder durable recorder function
 * @returns {void}
 */
export function configureStripeWebhookEventRecorder(recorder) {
  if (typeof recorder !== 'function') throw new TypeError('recorder must be a function');
  configuredRecorder = recorder;
}

/**
 * Record verified evidence when bootstrap has installed a durable recorder.
 * Pure verifier-only consumers may intentionally run without one.
 *
 * @param {{event: Record<string, unknown>, payloadSha256: string}} input verified event evidence
 * @returns {unknown|null} recorder result, or null when no runtime recorder exists
 */
export function recordVerifiedStripeWebhookEvent(input) {
  return configuredRecorder ? configuredRecorder(input) : null;
}

/**
 * Install normalized verified-event and delivery-evidence relations at bootstrap.
 *
 * Event facts are stored once by immutable Stripe event ID. Delivery attempts are
 * a separate one-to-many relation so retries remain auditable without duplicating
 * event metadata or retaining the signed raw JSON body. `replay_state` is the
 * delivery outcome; no second result column repeats that same functional fact.
 *
 * @param {import('node:sqlite').DatabaseSync} database open SQLite database
 * @returns {void}
 */
export function installStripeWebhookEventSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS billing_stripe_webhook_events (
      event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND ${MAX_EVENT_FIELD_LENGTH}),
      provider_created_at_sec INTEGER NOT NULL CHECK(provider_created_at_sec >= 0),
      event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND ${MAX_EVENT_FIELD_LENGTH}),
      object_id TEXT NOT NULL CHECK(length(object_id) BETWEEN 1 AND ${MAX_EVENT_FIELD_LENGTH}),
      object_type TEXT NOT NULL CHECK(length(object_type) BETWEEN 1 AND ${MAX_EVENT_FIELD_LENGTH}),
      api_version TEXT CHECK(api_version IS NULL OR length(api_version) BETWEEN 1 AND ${MAX_EVENT_FIELD_LENGTH}),
      request_id TEXT CHECK(request_id IS NULL OR length(request_id) BETWEEN 1 AND ${MAX_EVENT_FIELD_LENGTH}),
      payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
      first_received_at_ms INTEGER NOT NULL CHECK(first_received_at_ms >= 0)
    );
    CREATE INDEX IF NOT EXISTS billing_stripe_webhook_object_events
      ON billing_stripe_webhook_events(object_type, object_id, provider_created_at_sec);

    CREATE TABLE IF NOT EXISTS billing_stripe_webhook_deliveries (
      delivery_id INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES billing_stripe_webhook_events(event_id) ON DELETE CASCADE,
      received_at_ms INTEGER NOT NULL CHECK(received_at_ms >= 0),
      replay_state TEXT NOT NULL CHECK(replay_state IN ('first_delivery','duplicate_event'))
    );
    CREATE INDEX IF NOT EXISTS billing_stripe_webhook_event_deliveries
      ON billing_stripe_webhook_deliveries(event_id, delivery_id);
  `);
}

/**
 * Create a persistence port for cryptographically verified Stripe event evidence.
 *
 * The constructor never creates tables; call {@link installStripeWebhookEventSchema}
 * during database bootstrap. A repeated exact event ID plus payload hash is
 * idempotently acknowledged and recorded as replay evidence. Reusing an event ID
 * with different signed bytes fails closed rather than overwriting immutable facts.
 *
 * @param {import('node:sqlite').DatabaseSync} database bootstrapped SQLite database
 * @param {object} [dependencies] deterministic test seams
 * @param {() => number} [dependencies.now] wall-clock milliseconds
 * @returns {{recordVerifiedEvent(input: {event: Record<string, unknown>, payloadSha256: string}): {eventId: string, replayed: boolean, deliveryId: number}}}
 */
export function createSqliteStripeWebhookEventRepository(database, { now = Date.now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database must provide SQLite prepare/exec operations');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const selectEvent = database.prepare(`
    SELECT payload_sha256 FROM billing_stripe_webhook_events WHERE event_id = ?
  `);
  const insertEvent = database.prepare(`
    INSERT INTO billing_stripe_webhook_events(
      event_id, provider_created_at_sec, event_type, object_id, object_type,
      api_version, request_id, payload_sha256, first_received_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `);
  const insertDelivery = database.prepare(`
    INSERT INTO billing_stripe_webhook_deliveries(
      event_id, received_at_ms, replay_state
    ) VALUES(?,?,?)
  `);

  return {
    /** Persist one verified delivery and classify exact event-ID replay. */
    recordVerifiedEvent({ event, payloadSha256 }) {
      const normalized = normalizedEvent(event);
      const hash = normalizedPayloadHash(payloadSha256);
      const receivedAtMs = safeNow(now);

      return withSavepoint(database, () => {
        const existing = selectEvent.get(normalized.eventId);
        if (existing) {
          if (existing.payload_sha256 !== hash) {
            throw ledgerError('stripe_webhook_event_conflict', 409);
          }
          const delivery = insertDelivery.run(
            normalized.eventId,
            receivedAtMs,
            'duplicate_event',
          );
          return {
            eventId: normalized.eventId,
            replayed: true,
            deliveryId: Number(delivery.lastInsertRowid),
          };
        }

        insertEvent.run(
          normalized.eventId,
          normalized.providerCreatedAtSec,
          normalized.eventType,
          normalized.objectId,
          normalized.objectType,
          normalized.apiVersion,
          normalized.requestId,
          hash,
          receivedAtMs,
        );
        const delivery = insertDelivery.run(
          normalized.eventId,
          receivedAtMs,
          'first_delivery',
        );
        return {
          eventId: normalized.eventId,
          replayed: false,
          deliveryId: Number(delivery.lastInsertRowid),
        };
      });
    },
  };
}
