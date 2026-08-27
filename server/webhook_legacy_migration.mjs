import { validateWebhookRegistrationUrl } from './webhook_transport.mjs';

const SECURITY_ACTION = 'webhook.security_block';
const NEXT_ACTION = 'register_public_https_replacement';

function isCurrentDestinationAllowed(url) {
  try {
    validateWebhookRegistrationUrl(url);
    return true;
  } catch {
    return false;
  }
}

function blockedReasonFor(url) {
  try {
    return new URL(String(url ?? '')).protocol === 'http:'
      ? 'insecure_scheme'
      : 'destination_policy';
  } catch {
    return 'destination_policy';
  }
}

/**
 * Disable active legacy webhook destinations rejected by current registration policy.
 *
 * Historical ScopeWeave releases accepted broader HTTP(S) webhook URLs. Current
 * production registration requires public HTTPS, so leaving an incompatible row
 * active would repeatedly attempt a delivery that the transport must reject. This
 * migration reconciles every active row against the same synchronous registration
 * policy, disables rejected destinations, records why they were blocked, and emits
 * one tenant-visible audit event with a concrete replacement action. It never reads
 * or copies webhook signing secrets.
 *
 * DNS-backed hostnames remain subject to per-attempt address authorization and
 * socket pinning at delivery time; startup intentionally performs no network I/O.
 *
 * @param {import('node:sqlite').DatabaseSync} database Open ScopeWeave database.
 * @returns {number} Number of webhook rows newly disabled during this run.
 */
export function migrateLegacyWebhookDestinations(database) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const candidates = database.prepare(
      `SELECT id, org_id AS orgId, url
         FROM webhooks
        WHERE active = 1
        ORDER BY id`,
    ).all();
    const disable = database.prepare(
      `UPDATE webhooks
          SET active = 0,
              blocked_reason = ?
        WHERE id = ? AND org_id = ? AND active = 1`,
    );
    const audit = database.prepare(
      `INSERT INTO audit_log(org_id, user_id, action, target_type, target_id, meta)
       SELECT ?, NULL, ?, 'webhook', ?, ?
        WHERE changes() > 0
          AND NOT EXISTS (
            SELECT 1
              FROM audit_log
             WHERE org_id = ?
               AND action = ?
               AND target_type = 'webhook'
               AND target_id = ?
          )`,
    );

    let disabled = 0;
    for (const candidate of candidates) {
      if (isCurrentDestinationAllowed(candidate.url)) continue;
      const reason = blockedReasonFor(candidate.url);
      const targetId = String(candidate.id);
      const result = disable.run(reason, candidate.id, candidate.orgId);
      disabled += Number(result.changes);
      audit.run(
        candidate.orgId,
        SECURITY_ACTION,
        targetId,
        JSON.stringify({ reason, nextAction: NEXT_ACTION }),
        candidate.orgId,
        SECURITY_ACTION,
        targetId,
      );
    }
    database.exec('COMMIT');
    return disabled;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the causal migration failure if rollback itself also fails.
    }
    throw error;
  }
}
