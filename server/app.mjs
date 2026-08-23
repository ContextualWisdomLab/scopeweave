// ScopeWeave security gateway. The historical application remains in
// app_core.mjs while security-sensitive browser transports are migrated to
// short-lived, one-time access grants without exposing broad session JWTs in
// URLs. All other requests delegate to the unchanged core application.
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
const STREAM_TTL_SECONDS = 60;
const PRIVATE_VIEW_HEADERS = Object.freeze({
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});
const PRIVATE_STREAM_HEADERS = Object.freeze({
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
const GRANT_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const secureStreams = new Map();

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

function unauthorizedStream() {
  return secureJson({ error: 'unauthorized' }, 401, PRIVATE_STREAM_HEADERS);
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

function exactBodyKeys(body, allowedKeys) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every((key) => allowedKeys.includes(key));
}

async function mintAccessGrant(c) {
  const subjectId = lookupHeaderSubject(c);
  if (!subjectId) return secureJson({ error: 'unauthorized' }, 401);
  const projectId = rowId(c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  if (!projectId || !body) return secureJson({ error: 'invalid access grant request' }, 400);

  let purpose;
  let audience;
  let attachmentId = null;
  let ttlSeconds;
  let urlForGrant;

  if (body.purpose === ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW) {
    attachmentId = rowId(body.attachmentId);
    if (!attachmentId || !exactBodyKeys(body, ['purpose', 'attachmentId'])) {
      return secureJson({ error: 'invalid access grant request' }, 400);
    }
    purpose = ACCESS_GRANT_PURPOSES.ATTACHMENT_VIEW;
    audience = ACCESS_GRANT_AUDIENCES.ATTACHMENT_VIEW;
    ttlSeconds = ATTACHMENT_VIEW_TTL_SECONDS;
    urlForGrant = (secret) => `/api/projects/${projectId}/attachments/${attachmentId}/view?grant=${encodeURIComponent(secret)}`;
  } else if (body.purpose === ACCESS_GRANT_PURPOSES.STREAM) {
    if (!exactBodyKeys(body, ['purpose'])) return secureJson({ error: 'invalid access grant request' }, 400);
    purpose = ACCESS_GRANT_PURPOSES.STREAM;
    audience = ACCESS_GRANT_AUDIENCES.STREAM;
    ttlSeconds = STREAM_TTL_SECONDS;
    urlForGrant = (secret) => `/api/projects/${projectId}/stream?grant=${encodeURIComponent(secret)}`;
  } else {
    return secureJson({ error: 'invalid access grant request' }, 400);
  }

  try {
    const grant = await grantService.mint({
      subjectId,
      projectId,
      purpose,
      audience,
      attachmentId,
      ttlSeconds,
    });
    return secureJson({
      grantId: grant.grantId,
      purpose: grant.purpose,
      expiresAtMs: grant.expiresAtMs,
      url: urlForGrant(grant.secret),
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

function projectForSubject(subjectId, projectId) {
  return db.prepare(`
    SELECT p.id AS project_id
      FROM projects p
      JOIN memberships m ON m.org_id = p.org_id
     WHERE p.id = ? AND m.user_id = ?
  `).get(projectId, subjectId);
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

function secureStreamCount() {
  let count = 0;
  for (const controllers of secureStreams.values()) count += controllers.size;
  return count;
}

function broadcastSecureProjectEvent(projectId, payload) {
  const controllers = secureStreams.get(String(projectId));
  if (!controllers?.size) return;
  const chunk = new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
  for (const controller of [...controllers]) {
    try {
      controller.enqueue(chunk);
    } catch {
      controllers.delete(controller);
    }
  }
  if (!controllers.size) secureStreams.delete(String(projectId));
}

function openSecureProjectStream(projectId, requestSignal) {
  const key = String(projectId);
  let currentController = null;
  let aborted = false;
  const cleanup = (closeController = false) => {
    if (!currentController) return;
    secureStreams.get(key)?.delete(currentController);
    if (!secureStreams.get(key)?.size) secureStreams.delete(key);
    requestSignal?.removeEventListener?.('abort', onAbort);
    if (closeController) {
      try { currentController.close(); } catch { /* already closed */ }
    }
    currentController = null;
  };
  const onAbort = () => {
    aborted = true;
    cleanup(true);
  };

  const stream = new ReadableStream({
    start(controller) {
      currentController = controller;
      if (!secureStreams.has(key)) secureStreams.set(key, new Set());
      secureStreams.get(key).add(controller);
      controller.enqueue(new TextEncoder().encode(': connected\n\n'));
      if (requestSignal?.aborted) onAbort();
      else requestSignal?.addEventListener?.('abort', onAbort, { once: true });
    },
    cancel() {
      if (!aborted) cleanup(false);
    },
  });
  return new Response(stream, {
    headers: {
      ...PRIVATE_STREAM_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
    },
  });
}

async function openProjectStream(c) {
  const projectId = rowId(c.req.param('id'));
  if (!projectId) return unauthorizedStream();

  const url = new URL(c.req.url);
  const keys = [...url.searchParams.keys()];
  const grants = url.searchParams.getAll('grant');
  const hasAuthorization = Boolean(c.req.header('authorization'));
  let subjectId;

  if (grants.length > 0) {
    if (
      hasAuthorization
      || grants.length !== 1
      || keys.length !== 1
      || keys[0] !== 'grant'
      || !GRANT_SECRET_PATTERN.test(grants[0])
    ) return unauthorizedStream();
    try {
      const redeemed = await grantService.redeem({
        secret: grants[0],
        purpose: ACCESS_GRANT_PURPOSES.STREAM,
        audience: ACCESS_GRANT_AUDIENCES.STREAM,
        projectId,
        attachmentId: null,
      });
      subjectId = redeemed.subjectId;
    } catch {
      return unauthorizedStream();
    }
  } else {
    if (keys.length !== 0) return unauthorizedStream();
    subjectId = lookupHeaderSubject(c);
    if (!subjectId) return unauthorizedStream();
  }

  // Redemption checks live membership atomically, then this final read closes
  // the small post-consume race before opening a long-lived browser channel.
  if (!projectForSubject(subjectId, projectId)) return unauthorizedStream();
  return openSecureProjectStream(projectId, c.req.raw.signal);
}

async function serveModule(relativePath) {
  try {
    const source = await readFile(new URL(relativePath, import.meta.url));
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

async function serveMetrics(c) {
  const response = await coreApp.fetch(c.req.raw);
  if (!response.ok) return response;
  const active = secureStreamCount();
  if (c.req.query('format') === 'prometheus') {
    const text = await response.text();
    const patched = text.replace(/^scopeweave_sse_active\s+[-+0-9.eE]+$/m, `scopeweave_sse_active ${active}`);
    return new Response(patched, { status: response.status, headers: response.headers });
  }
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') return response;
  return new Response(JSON.stringify({ ...payload, sseActive: active }), {
    status: response.status,
    headers: response.headers,
  });
}

async function relayCoreRealtime(c, response) {
  if (!response.ok) return;
  const pathname = new URL(c.req.url).pathname;
  const method = c.req.method.toUpperCase();
  const updateMatch = /^\/api\/projects\/([1-9][0-9]*)$/.exec(pathname);
  const restoreMatch = /^\/api\/projects\/([1-9][0-9]*)\/revisions\/[1-9][0-9]*\/restore$/.exec(pathname);
  const commentMatch = /^\/api\/projects\/([1-9][0-9]*)\/comments$/.exec(pathname);

  if (method === 'PUT' && updateMatch) {
    const payload = await response.clone().json().catch(() => null);
    if (Number.isSafeInteger(payload?.version)) {
      broadcastSecureProjectEvent(updateMatch[1], { type: 'update', version: payload.version });
    }
  } else if (method === 'POST' && restoreMatch) {
    const payload = await response.clone().json().catch(() => null);
    if (Number.isSafeInteger(payload?.version)) {
      broadcastSecureProjectEvent(restoreMatch[1], { type: 'update', version: payload.version });
    }
  } else if (method === 'POST' && commentMatch) {
    const payload = await response.clone().json().catch(() => null);
    if (Number.isSafeInteger(payload?.id)) {
      broadcastSecureProjectEvent(commentMatch[1], { type: 'comment', commentId: payload.id });
    }
  }
}

async function delegateToCore(c) {
  const response = await coreApp.fetch(c.req.raw);
  await relayCoreRealtime(c, response);
  return response;
}

/** Public ScopeWeave HTTP application with browser access-grant enforcement. */
export const app = new Hono();

app.post('/api/projects/:id/access-grants', mintAccessGrant);
app.get('/api/projects/:id/attachments/:aid/view', viewAttachment);
app.get('/api/projects/:id/stream', openProjectStream);
app.get('/api/metrics', serveMetrics);
app.get('/cloud-sync-core.js', () => serveModule('../cloud-sync-core.js'));
app.get('/stream-access-grant.js', () => serveModule('../stream-access-grant.js'));
app.all('*', delegateToCore);
