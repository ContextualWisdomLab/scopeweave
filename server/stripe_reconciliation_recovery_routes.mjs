import { Hono } from 'hono';

import { hashApiToken, verifyToken } from './auth.mjs';
import {
  db,
  recoverStripeBillingDeadLetter,
  stripeReconciliationRecoveries,
} from './db.mjs';
import { StripeReconciliationRecoveryError } from './stripe_reconciliation_recovery.mjs';

const MAX_RECOVERY_REQUEST_BYTES = 4 * 1024;
const DECIMAL_INTEGER_PATTERN = /^\d+$/u;

function organizationRole(userId, organizationId) {
  return db.prepare('SELECT role FROM memberships WHERE user_id = ? AND org_id = ?')
    .get(userId, organizationId)?.role ?? null;
}

function canManage(role) {
  return role === 'owner' || role === 'admin';
}

async function requireRecoveryAuth(c, next) {
  const header = c.req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (token.startsWith('swk_')) {
    const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hashApiToken(token));
    if (!row) return c.json({ error: 'unauthorized' }, 401);
    db.prepare("UPDATE api_tokens SET last_used = datetime('now') WHERE id = ?").run(row.id);
    c.set('recoveryUserId', Number(row.user_id));
    return next();
  }

  try {
    const payload = verifyToken(token);
    const user = db.prepare('SELECT token_version FROM users WHERE id = ?').get(payload.sub);
    if (!user || (payload.tv || 0) !== user.token_version) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('recoveryUserId', Number(payload.sub));
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
}

function recoveryFailure(c, error) {
  if (error instanceof StripeReconciliationRecoveryError) {
    return c.json({ error: error.code }, error.status, { 'Cache-Control': 'no-store' });
  }
  return c.json(
    { error: 'stripe_reconciliation_recovery_unavailable' },
    500,
    { 'Cache-Control': 'no-store' },
  );
}

function recoveryRequestError(code, status = 400) {
  return new StripeReconciliationRecoveryError(code, status);
}

async function readBoundedRecoveryJson(request) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const normalizedLength = declaredLength.trim();
    if (!DECIMAL_INTEGER_PATTERN.test(normalizedLength)) {
      throw recoveryRequestError('stripe_reconciliation_recovery_invalid');
    }
    const length = Number(normalizedLength);
    if (!Number.isSafeInteger(length)) {
      throw recoveryRequestError('stripe_reconciliation_recovery_invalid');
    }
    if (length > MAX_RECOVERY_REQUEST_BYTES) {
      throw recoveryRequestError('stripe_reconciliation_recovery_body_too_large', 413);
    }
  }

  const reader = request.body?.getReader?.();
  if (!reader || typeof reader.read !== 'function') return {};

  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      let result;
      try {
        result = await reader.read();
      } catch {
        throw recoveryRequestError('stripe_reconciliation_recovery_invalid');
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw recoveryRequestError('stripe_reconciliation_recovery_invalid');
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_RECOVERY_REQUEST_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best effort after the request has already failed closed.
        }
        throw recoveryRequestError('stripe_reconciliation_recovery_body_too_large', 413);
      }
      chunks.push(result.value);
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Reader cleanup cannot change the bounded request result.
    }
  }

  if (totalBytes === 0) return {};
  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
    return JSON.parse(text);
  } catch {
    throw recoveryRequestError('stripe_reconciliation_recovery_invalid');
  }
}

function auditRecovery(organizationId, actorUserId, result) {
  try {
    db.prepare(`
      INSERT INTO audit_log(org_id,user_id,action,target_type,target_id,meta)
      VALUES(?,?,?,?,?,?)
    `).run(
      organizationId,
      actorUserId,
      'billing.reconciliation.recover',
      'stripe_event',
      result.eventId,
      JSON.stringify({
        recoveryId: result.recoveryId,
        attemptNumber: result.attemptNumber,
        status: result.status,
        replayed: result.replayed,
      }),
    );
  } catch {
    // The normalized recovery table is the durable recovery authority. This legacy
    // product audit stream is additive evidence and must not make an idempotent retry
    // appear to fail after provider/state work has already completed.
  }
}

/**
 * Tenant-scoped operator API for Stripe reconciliation dead-letter recovery.
 *
 * The route graph deliberately exposes no lease token, provider secret, raw webhook
 * payload, or caller-selected Subscription identity. Owners/admins can inspect their
 * bounded backlog and retry one exact verified Event using a durable evidence reference.
 * Recovery JSON is capped at 4 KiB from both declared and streamed byte evidence before
 * parsing so a privileged tenant cannot turn the narrow operator endpoint into an
 * unbounded process-memory allocation.
 */
export const stripeReconciliationRecoveryRoutes = new Hono();

stripeReconciliationRecoveryRoutes.get(
  '/api/orgs/:id/billing/reconciliation/dead-letters',
  requireRecoveryAuth,
  (c) => {
    const actorUserId = c.get('recoveryUserId');
    const organizationId = Number(c.req.param('id'));
    const role = Number.isSafeInteger(organizationId) && organizationId > 0
      ? organizationRole(actorUserId, organizationId)
      : null;
    if (!role) return c.json({ error: 'not found' }, 404, { 'Cache-Control': 'no-store' });
    if (!canManage(role)) return c.json({ error: 'forbidden' }, 403, { 'Cache-Control': 'no-store' });

    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    try {
      const deadLetters = stripeReconciliationRecoveries.listDeadLetters({
        organizationId,
        limit,
      });
      return c.json({ deadLetters }, 200, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return recoveryFailure(c, error);
    }
  },
);

stripeReconciliationRecoveryRoutes.post(
  '/api/orgs/:id/billing/reconciliation/dead-letters/:eventId/retry',
  requireRecoveryAuth,
  async (c) => {
    const actorUserId = c.get('recoveryUserId');
    const organizationId = Number(c.req.param('id'));
    const role = Number.isSafeInteger(organizationId) && organizationId > 0
      ? organizationRole(actorUserId, organizationId)
      : null;
    if (!role) return c.json({ error: 'not found' }, 404, { 'Cache-Control': 'no-store' });
    if (!canManage(role)) return c.json({ error: 'forbidden' }, 403, { 'Cache-Control': 'no-store' });

    try {
      const body = await readBoundedRecoveryJson(c.req.raw);
      const result = await recoverStripeBillingDeadLetter({
        organizationId,
        eventId: c.req.param('eventId'),
        actorUserId,
        evidenceReference: body?.evidenceReference,
      });
      auditRecovery(organizationId, actorUserId, result);
      const status = result.status === 'processing' ? 202 : 200;
      return c.json(result, status, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return recoveryFailure(c, error);
    }
  },
);
