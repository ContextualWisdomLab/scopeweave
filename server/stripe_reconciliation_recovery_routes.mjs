import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { hashApiToken, verifyToken } from './auth.mjs';
import {
  db,
  recoverStripeBillingDeadLetter,
  stripeReconciliationRecoveries,
} from './db.mjs';
import {
  StripeReconciliationEvidenceExportError,
  createSqliteStripeReconciliationEvidenceExportRepository,
} from './stripe_reconciliation_evidence_export.mjs';
import { StripeReconciliationRecoveryError } from './stripe_reconciliation_recovery.mjs';

const MAX_RECOVERY_REQUEST_BYTES = 4 * 1024;
const EVIDENCE_EXPORT_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});
const EVIDENCE_EXPORT_DOWNLOAD_HEADERS = Object.freeze({
  ...EVIDENCE_EXPORT_HEADERS,
  'Content-Disposition': 'attachment; filename="scopeweave-stripe-reconciliation-evidence.json"',
});
const stripeReconciliationEvidenceExports =
  createSqliteStripeReconciliationEvidenceExportRepository(db);

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

function evidenceExportFailure(c, error) {
  if (error instanceof StripeReconciliationEvidenceExportError) {
    return c.json({ error: error.code }, error.status, EVIDENCE_EXPORT_HEADERS);
  }
  return c.json(
    { error: 'stripe_reconciliation_evidence_export_unavailable' },
    500,
    EVIDENCE_EXPORT_HEADERS,
  );
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
 * Tenant-scoped operator API for Stripe reconciliation evidence and dead-letter recovery.
 *
 * The route graph deliberately exposes no lease token, provider secret, raw webhook
 * payload, or caller-selected Subscription identity. Owners/admins can export their
 * bounded reconciliation evidence, inspect their bounded backlog, and retry one exact
 * verified Event using a durable evidence reference. Recovery JSON is capped at 4 KiB
 * by Hono's body-limit middleware, which checks declared Content-Length and streamed
 * bytes before the JSON parser can buffer an unbounded privileged request.
 */
export const stripeReconciliationRecoveryRoutes = new Hono();

stripeReconciliationRecoveryRoutes.get(
  '/api/orgs/:id/billing/reconciliation/evidence',
  requireRecoveryAuth,
  (c) => {
    const actorUserId = c.get('recoveryUserId');
    const organizationId = Number(c.req.param('id'));
    const role = Number.isSafeInteger(organizationId) && organizationId > 0
      ? organizationRole(actorUserId, organizationId)
      : null;
    if (!role) return c.json({ error: 'not found' }, 404, EVIDENCE_EXPORT_HEADERS);
    if (!canManage(role)) return c.json({ error: 'forbidden' }, 403, EVIDENCE_EXPORT_HEADERS);

    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    try {
      const report = stripeReconciliationEvidenceExports.exportTenantEvidence({
        organizationId,
        limit,
      });
      return c.json(report, 200, EVIDENCE_EXPORT_DOWNLOAD_HEADERS);
    } catch (error) {
      return evidenceExportFailure(c, error);
    }
  },
);

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
  bodyLimit({
    maxSize: MAX_RECOVERY_REQUEST_BYTES,
    onError: (c) => c.json(
      { error: 'stripe_reconciliation_recovery_body_too_large' },
      413,
      { 'Cache-Control': 'no-store' },
    ),
  }),
  async (c) => {
    const actorUserId = c.get('recoveryUserId');
    const organizationId = Number(c.req.param('id'));
    const role = Number.isSafeInteger(organizationId) && organizationId > 0
      ? organizationRole(actorUserId, organizationId)
      : null;
    if (!role) return c.json({ error: 'not found' }, 404, { 'Cache-Control': 'no-store' });
    if (!canManage(role)) return c.json({ error: 'forbidden' }, 403, { 'Cache-Control': 'no-store' });

    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await recoverStripeBillingDeadLetter({
        organizationId,
        eventId: c.req.param('eventId'),
        actorUserId,
        evidenceReference: body.evidenceReference,
      });
      auditRecovery(organizationId, actorUserId, result);
      const status = result.status === 'processing' ? 202 : 200;
      return c.json(result, status, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return recoveryFailure(c, error);
    }
  },
);
