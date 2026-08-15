import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';

import { app as legacyApp } from './app.mjs';
import { verifyToken, hashApiToken } from './auth.mjs';
import { artifactUrl } from './clearfolio.mjs';
import { db } from './db.mjs';
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

const ATTACHMENT_VIEW_GRANT_TTL_SECONDS = 60;
const ATTACHMENT_VIEW_PURPOSE = ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW;
const ATTACHMENT_VIEW_AUDIENCE = ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW;

const repository = createSqliteAccessGrantRepository(db);
const grantService = createAccessGrantService({
  repository,
  clock: { nowMs: () => Date.now() },
  randomSource: { randomBytes: (length) => randomBytes(length) },
  // The SQLite repository commits an immutable, secret-free audit-outbox row in
  // the same savepoint as mint/consume. This sink is intentionally a no-op so
  // the runtime does not create a second, weaker audit source of truth.
  auditSink: { record: async () => {} },
  projectAuthorization: createSqliteAccessGrantAuthorizationPort(db),
  membershipRevocation: createSqliteAccessGrantMembershipPort(db),
});

/**
 * Resolve an Authorization-header JWT or PAT without accepting URL credentials.
 *
 * @param {import('hono').Context} c Current Hono request context.
 * @returns {string|null} Authenticated subject id, or null when the credential
 * is absent, invalid, or revoked.
 */
function headerSubjectId(c) {
  const header = c.req.header('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const raw = header.slice(7);
  if (!raw) return null;
  if (raw.startsWith('swk_')) {
    const tokenRow = db.prepare(
      'SELECT id, user_id FROM api_tokens WHERE token_hash = ?',
    ).get(hashApiToken(raw));
    if (!tokenRow) return null;
    db.prepare("UPDATE api_tokens SET last_used = datetime('now') WHERE id = ?")
      .run(tokenRow.id);
    return String(tokenRow.user_id);
  }
  try {
    const payload = verifyToken(raw);
    const userRow = db.prepare('SELECT token_version FROM users WHERE id = ?')
      .get(payload.sub);
    if (!userRow || (payload.tv || 0) !== userRow.token_version) return null;
    return String(payload.sub);
  } catch {
    return null;
  }
}

function projectForSubject(subjectId, projectId) {
  return db.prepare(`
    SELECT p.id, p.org_id
      FROM projects p
      JOIN memberships m ON m.org_id = p.org_id
     WHERE p.id = ? AND m.user_id = ?
  `).get(projectId, subjectId);
}

function attachmentForProject(projectId, attachmentId) {
  return db.prepare(
    'SELECT job_id, status FROM attachments WHERE id = ? AND project_id = ?',
  ).get(attachmentId, projectId);
}

function setPrivateUrlResponseHeaders(c) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'same-origin');
}

function mintFailureResponse(c, error) {
  if (error instanceof AccessGrantError) {
    return c.json({ error: error.code }, error.status);
  }
  if (error?.message === 'access_grant_membership_inactive') {
    return c.json({ error: 'access_grant_not_authorized' }, 404);
  }
  return c.json({ error: 'access_grant_unavailable' }, 503);
}

function redeemFailureResponse(c, error) {
  if (error instanceof AccessGrantError) {
    return c.json({ error: 'access_grant_unauthorized' }, 401);
  }
  return c.json({ error: 'access_grant_unavailable' }, 503);
}

/**
 * Runtime API boundary that intercepts attachment grant exchange/view routes
 * before delegating all unrelated requests to the established ScopeWeave app.
 *
 * Keeping the boundary in a dedicated module lets the grant migration remain a
 * bounded vertical slice while the larger app is decomposed incrementally. The
 * protected server entry point imports this app, so the legacy attachment-view
 * handler cannot receive a browser query JWT in production.
 */
export const app = new Hono();

app.post('/api/projects/:id/access-grants', async (c) => {
  const subjectId = headerSubjectId(c);
  if (!subjectId) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  if (body.purpose !== ATTACHMENT_VIEW_PURPOSE) {
    return c.json({ error: 'access_grant_request_invalid' }, 400, {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    });
  }
  const attachmentId = typeof body.attachmentId === 'string'
    ? body.attachmentId
    : Number.isSafeInteger(body.attachmentId)
      ? String(body.attachmentId)
      : undefined;
  try {
    const minted = await grantService.mint({
      subjectId,
      projectId: String(c.req.param('id')),
      purpose: ATTACHMENT_VIEW_PURPOSE,
      audience: ATTACHMENT_VIEW_AUDIENCE,
      attachmentId,
      ttlSeconds: ATTACHMENT_VIEW_GRANT_TTL_SECONDS,
    });
    return c.json({
      grant: minted.secret,
      grantId: minted.grantId,
      purpose: minted.purpose,
      projectId: minted.projectId,
      attachmentId: minted.attachmentId,
      expiresAtMs: minted.expiresAtMs,
    }, 201, {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    });
  } catch (error) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return mintFailureResponse(c, error);
  }
});

app.get('/api/projects/:id/attachments/:aid/view', async (c) => {
  setPrivateUrlResponseHeaders(c);
  const projectId = String(c.req.param('id'));
  const attachmentId = String(c.req.param('aid'));
  const legacyQueryToken = c.req.query('token');
  if (legacyQueryToken) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let subjectId = headerSubjectId(c);
  if (!subjectId) {
    const grant = c.req.query('grant') || '';
    try {
      const redeemed = await grantService.redeem({
        secret: grant,
        purpose: ATTACHMENT_VIEW_PURPOSE,
        audience: ATTACHMENT_VIEW_AUDIENCE,
        projectId,
        attachmentId,
      });
      subjectId = String(redeemed.subjectId);
    } catch (error) {
      return redeemFailureResponse(c, error);
    }
  }

  const project = projectForSubject(subjectId, projectId);
  if (!project) return c.json({ error: 'not found' }, 404);
  const attachment = attachmentForProject(project.id, attachmentId);
  if (!attachment) return c.json({ error: 'not found' }, 404);
  if (attachment.status !== 'SUCCEEDED') {
    return c.json({ error: `문서가 아직 준비되지 않았습니다 (${attachment.status})` }, 409);
  }
  try {
    const url = await artifactUrl(project.org_id, Number(subjectId), attachment.job_id);
    return c.redirect(url, 302);
  } catch {
    return c.json({ error: '열람 링크 발급 실패: 문서 제공자를 확인하고 다시 시도해 주세요.' }, 502);
  }
});

app.all('*', (c) => legacyApp.fetch(c.req.raw));
