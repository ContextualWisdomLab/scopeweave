import { validateWebhookRegistrationUrl } from './webhook_transport.mjs';

const SECURITY_ACTION = 'webhook.security_block';
const SECURITY_META = JSON.stringify({
  reason: 'insecure_scheme',
  nextAction: 'register_public_https_replacement',
});

function isPreservedDevelopmentLoopback(url, allowDevelopmentLoopback) {
  if (!allowDevelopmentLoopback) return false;
  try {
    const canonical = validateWebhookRegistrationUrl(url, {
      allowDevelopmentLoopback: true,
    });
    return new URL(canonical).protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Disable previously accepted HTTP webhook destinations before requests serve.
 *
 * Historical ScopeWeave releases accepted arbitrary `http://` webhook URLs.
 * Production delivery now requires public HTTPS, so leaving those rows active
 * would create an endless silent retry loop. This migration disables only
 * active legacy HTTP rows, writes one tenant-visible audit event with a concrete
 * replacement action, and never reads or copies the webhook signing secret.
 * Explicit development mode preserves only loopback HTTP URLs that the current
 * destination policy still permits.
 *
 * @param {import('node:sqlite').DatabaseSync} database Open ScopeWeave database.
 * @param {{allowDevelopmentLoopback?: boolean}} [options] Migration policy.
 * @returns {number} Number of webhook rows newly disabled during this run.
 */
export function migrateLegacyWebhookDestinations(
  database,
  { allowDevelopmentLoopback = false } = {},
) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const candidates = database.prepare(
      `SELECT id, org_id AS orgId, url
         FROM webhooks
        WHERE active = 1 AND lower(url) LIKE 'http://%'
        ORDER BY id`,
    ).all();
    const disable = database.prepare(
      'UPDATE webhooks SET active = 0 WHERE id = ? AND org_id = ? AND active = 1',
    );
    const audit = database.prepare(
      `INSERT INTO audit_log(org_id, user_id, action, target_type, target_id, meta)
       SELECT ?, NULL, ?, 'webhook', ?, ?
        WHERE NOT EXISTS (
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
      if (isPreservedDevelopmentLoopback(candidate.url, allowDevelopmentLoopback)) {
        continue;
      }
      const targetId = String(candidate.id);
      const result = disable.run(candidate.id, candidate.orgId);
      if (!result.changes) continue;
      disabled += Number(result.changes);
      audit.run(
        candidate.orgId,
        SECURITY_ACTION,
        targetId,
        SECURITY_META,
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
    } finally {
      throw error;
    }
  }
}
