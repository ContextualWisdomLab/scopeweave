// ScopeWeave security gateway. The historical application remains in
// app_core.mjs while security-sensitive attachment viewing is migrated to
// short-lived, one-time access grants without exposing broad session JWTs in
// browser URLs. All other requests delegate to the unchanged core application.
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { db } from './db.mjs';
import { hashApiToken, verifyToken } from './auth.mjs';
import { artifactUrl } from './clearfolio.mjs';
import { app as coreApp } from './app_core.mjs';
import {
  ACCESS_GRANT_AUDIENCES,
  ACCESS_GRANT_PURPOSES,
  AccessGrantError,
  createAccessGrantService,
} from './access_grant_domain.mjs';
import {
  createSqliteAccessGrantAuthorizationPort,
  createSqliteAccessGrantMembershipPort,
  createSqliteAccessGrantRepository,
} from './access_grant_sqlite.mjs';

const ATTACHMENT_VIEW_TTL_SECONDS = 60;
const PRIVATE_VIEW_HEADERS = Object.freeze({
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});
const GRANT_RESPONSE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});
const ROW_ID_PATTERN = /^[1-9][0-9]*$/;

function rowId(value) {
  const normalized = String(value ?? '');
  return ROW_ID_PATTERN.test(normalized) ? normalized : null;
}

function secureJson(payload, status, headers = GRANT_RESPONSE_HEADERS) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...headers,
      'content-type': 'application/json; charset=UTF-8',
    },
  });
}

function unauthorizedView() {
  return secureJson({ error: 'unauthorized' }, 401, PRIVATE_VIEW_HEADERS);
}

function lookupHeaderSubject(c) {
  const header = c.req.header('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (token.startsWith('swk_')) {
    const apiToken = db.prepare('SELECT id,user_id FROM api_tokens WHERE token_hash = ?').get(hashApiToken(token));
    if (!apiToken) return null;
    db.prepare("UPDATE api_tokens SET last_used = datetime('now') WHERE id = ?").run(apiToken.id);
    return String(apiToken.user_id);
  }
  try {
    const payload = verifyToken(token);
    const user = db.prepare('SELECT token_version FROM users WHERE id = ?').get(payload.sub);
    if (!user || (payload.tv || 0) !== user.token_version) return null;
    return String(payload.sub);
  } catch {
    return null;
  }
}

const grantService = createAccessGrantService({
  repository: createSqliteAccessGrantRepository(db),
  clock: Object.freeze({ nowMs: () => Date.now() }),
  randomSource: Object.freeze({ randomBytes: (size) => randomBytes(size) }),
  // The SQLite repository transactionally persists the authoritative immutable
  // access_grant_audit_outbox entry. The domain's delivery sink is deliberately
  // side-effect-free here so an optional secondary sink cannot change security
  // state or encourage a duplicate mint/redeem retry.
  auditSink: Object.freeze({ record: async () => {} }),
  projectAuthorization: createSqliteAccessGrantAuthorizationPort(db),
  membershipRevocation: createSqliteAccessGrantMembershipPort(db),
});

function mapMintFailure(error) {
  if (error instanceof AccessGrantError) {
    if (error.status === 404) return secureJson({ error: 'not found' }, 404);
    if (error.status === 400) return secureJson({ error: 'invalid access grant request' }, 400);
  }
  return secureJson({ error: 'access grant service unavailable' }, 503);
}

async function mintAttachmentViewGrant(c) {
  const subjectId = lookupHeaderSubject(c);
  if (!subjectId) return secureJson({ error: 'unauthorized' }, 401);
  const projectId = rowId(c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  const attachmentId = rowId(body?.attachmentId);
  if (!projectId || body?.purpose !== ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW || !attachmentId) {
    return secureJson({ error: 'invalid access grant request' }, 400);
  }

  try {
    const grant = await grantService.mint({
      subjectId,
      projectId,
      purpose: ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW,
      audience: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
      attachmentId,
      ttlSeconds: ATTACHMENT_VIEW_TTL_SECONDS,
    });
    return secureJson({
      grantId: grant.grantId,
      purpose: grant.purpose,
      expiresAtMs: grant.expiresAtMs,
      url: `/api/projects/${projectId}/attachments/${attachmentId}/view?grant=${encodeURIComponent(grant.secret)}`,
    }, 201);
  } catch (error) {
    return mapMintFailure(error);
  }
}

function attachmentForSubject(subjectId, projectId, attachmentId) {
  return db.prepare(`
    SELECT p.org_id AS org_id, a.job_id AS job_id, a.status AS status
      FROM projects p
      JOIN memberships m ON m.org_id = p.org_id
      JOIN attachments a ON a.project_id = p.id
     WHERE p.id = ? AND m.user_id = ? AND a.id = ?
  `).get(projectId, subjectId, attachmentId);
}

async function viewAttachment(c) {
  const projectId = rowId(c.req.param('id'));
  const attachmentId = rowId(c.req.param('aid'));
  if (!projectId || !attachmentId) return unauthorizedView();

  const search = new URL(c.req.url).searchParams;
  if (search.has('token')) return unauthorizedView();

  const grantValues = search.getAll('grant');
  let subjectId;
  if (grantValues.length > 0) {
    if (grantValues.length !== 1) return unauthorizedView();
    try {
      const redeemed = await grantService.redeem({
        secret: grantValues[0],
        purpose: ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW,
        audience: ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW,
        projectId,
        attachmentId,
      });
      subjectId = redeemed.subjectId;
    } catch {
      return unauthorizedView();
    }
  } else {
    subjectId = lookupHeaderSubject(c);
    if (!subjectId) return unauthorizedView();
  }

  const attachment = attachmentForSubject(subjectId, projectId, attachmentId);
  if (!attachment) return secureJson({ error: 'not found' }, 404, PRIVATE_VIEW_HEADERS);
  if (attachment.status !== 'SUCCEEDED') {
    return secureJson({ error: 'attachment not ready' }, 409, PRIVATE_VIEW_HEADERS);
  }

  try {
    const target = await artifactUrl(attachment.org_id, subjectId, attachment.job_id);
    return new Response(null, {
      status: 302,
      headers: {
        ...PRIVATE_VIEW_HEADERS,
        location: target,
      },
    });
  } catch {
    return secureJson({ error: 'document viewer unavailable' }, 502, PRIVATE_VIEW_HEADERS);
  }
}

async function serveCloudSyncCore() {
  try {
    const source = await readFile(new URL('../cloud-sync-core.js', import.meta.url));
    return new Response(source, {
      status: 200,
      headers: {
        'cache-control': 'no-cache',
        'content-type': 'application/javascript; charset=UTF-8',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return secureJson({ error: 'not found' }, 404);
  }
}

/** Public ScopeWeave HTTP application with attachment-view grant enforcement. */
export const app = new Hono();

app.post('/api/projects/:id/access-grants', mintAttachmentViewGrant);
app.get('/api/projects/:id/attachments/:aid/view', viewAttachment);
app.get('/cloud-sync-core.js', serveCloudSyncCore);
app.all('*', (c) => coreApp.fetch(c.req.raw));
