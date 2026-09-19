import { validateWebhookRegistrationUrl } from './webhook_transport.mjs';

const SECURITY_ACTION = 'webhook.security_block';
const SECURITY_META = JSON.stringify({
  reason: 'destination_policy',
  nextAction: 'register_public_https_replacement',
});

function isCurrentDestinationAllowed(url, allowDevelopmentLoopback) {
  try {
    validateWebhookRegistrationUrl(url, { allowDevelopmentLoopback });
    return true;
  } catch {
    return false;
  }
}

function activeWebhookDestinations(database) {
  return database.prepare(
    `SELECT id, org_id AS orgId, url
       FROM webhooks
      WHERE active = 1
      ORDER BY id`,
  ).all();
}

function hasPolicyIncompatibleDestination(candidates, allowDevelopmentLoopback) {
  return candidates.some(
    (candidate) => !isCurrentDestinationAllowed(candidate.url, allowDevelopmentLoopback),
  );
}

/**
 * Disable active legacy webhook destinations rejected by current registration policy.
 *
 * Historical ScopeWeave releases accepted arbitrary HTTP(S) webhook URLs,
 * including local/private HTTPS literals and names. Current production
 * registration requires public HTTPS, so leaving policy-incompatible rows active
 * would create an endless silent retry loop. This migration examines every active
 * row, disables only destinations rejected by the current synchronous registration
 * policy, writes one tenant-visible audit event with a concrete replacement action,
 * and never reads or copies the webhook signing secret. Explicit development mode
 * preserves only destinations that the same current development registration
 * policy still permits, including loopback HTTP.
 *
 * A read-only preflight avoids reserving the SQLite writer when every active row
 * already satisfies current policy. If a write is required, the migration acquires
 * `BEGIN IMMEDIATE` and re-reads the active rows inside that transaction before any
 * mutation, preserving the existing atomic fail-closed migration boundary.
 *
 * DNS-backed hostnames remain subject to per-attempt address authorization at
 * delivery time; this startup migration deliberately does not perform network I/O.
 *
 * @param {import('node:sqlite').DatabaseSync} database Open ScopeWeave database.
 * @param {{allowDevelopmentLoopback?: boolean}} [options] Migration policy.
 * @returns {number} Number of webhook rows newly disabled during this run.
 */
export function migrateLegacyWebhookDestinations(
  database,
  { allowDevelopmentLoopback = false } = {},
) {
  const preflightCandidates = activeWebhookDestinations(database);
  if (!hasPolicyIncompatibleDestination(preflightCandidates, allowDevelopmentLoopback)) {
    return 0;
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const candidates = activeWebhookDestinations(database);
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
      if (isCurrentDestinationAllowed(candidate.url, allowDevelopmentLoopback)) {
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
    } catch {
      // Preserve the causal migration failure if rollback itself also fails.
    }
    throw error;
  }
}
