"""Apply the bounded PR 397 session-revocation repair.

This temporary script centralizes session JWT validation, extends URL-transport
revocation regression coverage, and updates the changelog. The invoking
workflow deletes this script after all validation commands pass.
"""

from pathlib import Path


def replace_exact(path_name: str, old: str, new: str) -> None:
    """Replace one exact text fragment or fail without guessing."""
    path = Path(path_name)
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"expected text not found in {path_name}: {old[:100]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_exact(
    "server/app.mjs",
    """const canManage = (role) => role === 'owner' || role === 'admin';
const canWrite = (role) => role === 'owner' || role === 'admin' || role === 'member';

export const app = new Hono();""",
    """const canManage = (role) => role === 'owner' || role === 'admin';
const canWrite = (role) => role === 'owner' || role === 'admin' || role === 'member';

// Verify a session JWT and enforce database-backed logout-all revocation.
// Throws on malformed, expired, missing-user, or stale-session credentials.
function verifySessionJwt(token) {
  const payload = verifyToken(token);
  const user = db.prepare('SELECT token_version FROM users WHERE id = ?').get(payload.sub);
  if (!user || (payload.tv || 0) !== user.token_version) throw new Error('revoked session');
  return payload;
}

export const app = new Hono();""",
)

replace_exact(
    "server/app.mjs",
    """  try {
    const payload = verifyToken(token);
    // Session revocation: a bumped token_version invalidates all older JWTs.
    const u = db.prepare('SELECT token_version FROM users WHERE id = ?').get(payload.sub);
    if (!u || (payload.tv || 0) !== u.token_version) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', payload);
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }""",
    """  try {
    c.set('user', verifySessionJwt(token));
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }""",
)

jwt_branch = """  } else {
    try {
      const payload = verifyToken(raw);
      const u = db.prepare('SELECT token_version FROM users WHERE id = ?').get(payload.sub);
      if (!u || (payload.tv || 0) !== u.token_version) return c.json({ error: 'unauthorized' }, 401);
      uid = payload.sub;
    } catch { return c.json({ error: 'unauthorized' }, 401); }
  }"""
jwt_replacement = """  } else {
    try { uid = verifySessionJwt(raw).sub; }
    catch { return c.json({ error: 'unauthorized' }, 401); }
  }"""
app_path = Path("server/app.mjs")
app_text = app_path.read_text(encoding="utf-8")
branch_count = app_text.count(jwt_branch)
if branch_count != 2:
    raise SystemExit(f"expected two PAT-preserving JWT branches, found {branch_count}")
app_path.write_text(app_text.replace(jwt_branch, jwt_replacement), encoding="utf-8")

replace_exact(
    "server/app.mjs",
    """  let user;
  try {
    user = verifyToken(token);
    const u = db.prepare('SELECT token_version FROM users WHERE id = ?').get(user.sub);
    if (!u || (user.tv || 0) !== u.token_version) return c.json({ error: 'unauthorized' }, 401);
  } catch { return c.json({ error: 'unauthorized' }, 401); }""",
    """  let user;
  try { user = verifySessionJwt(token); }
  catch { return c.json({ error: 'unauthorized' }, 401); }""",
)

replace_exact(
    "tests/api/session-revocation.test.mjs",
    """async function expectCalendarStatus(projectId, token, status, message) {
  const response = await req(
    `/api/projects/${projectId}/calendar.ics?token=${encodeURIComponent(token)}`
  );
  assert.equal(response.status, status, message);
}

test('logout-all revokes calendar and SSE query JWTs across devices', async () => {""",
    """async function expectCalendarStatus(projectId, token, status, message) {
  const response = await req(
    `/api/projects/${projectId}/calendar.ics?token=${encodeURIComponent(token)}`
  );
  assert.equal(response.status, status, message);
}

async function expectAttachmentViewStatus(projectId, token, status, message) {
  const response = await req(
    `/api/projects/${projectId}/attachments/missing/view?token=${encodeURIComponent(token)}`
  );
  assert.equal(response.status, status, message);
}

test('logout-all revokes every URL-transport session JWT across devices', async () => {""",
)

replace_exact(
    "tests/api/session-revocation.test.mjs",
    """  await expectStreamStatus(projectId, tokenA, 200, 'SSE accepts token A before revocation');
  await expectStreamStatus(projectId, tokenB, 200, 'SSE accepts token B before revocation');""",
    """  await expectStreamStatus(projectId, tokenA, 200, 'SSE accepts token A before revocation');
  await expectStreamStatus(projectId, tokenB, 200, 'SSE accepts token B before revocation');
  await expectAttachmentViewStatus(projectId, tokenA, 404, 'attachment view authenticates token A before lookup');
  await expectAttachmentViewStatus(projectId, tokenB, 404, 'attachment view authenticates token B before lookup');""",
)

replace_exact(
    "tests/api/session-revocation.test.mjs",
    """    await expectStreamStatus(
      projectId,
      staleToken,
      401,
      `SSE rejects stale token ${label}`
    );
  }

  await expectCalendarStatus(projectId, freshToken, 200, 'calendar accepts replacement token');
  await expectStreamStatus(projectId, freshToken, 200, 'SSE accepts replacement token');""",
    """    await expectStreamStatus(
      projectId,
      staleToken,
      401,
      `SSE rejects stale token ${label}`
    );
    await expectAttachmentViewStatus(
      projectId,
      staleToken,
      401,
      `attachment view rejects stale token ${label}`
    );
  }

  await expectCalendarStatus(projectId, freshToken, 200, 'calendar accepts replacement token');
  await expectStreamStatus(projectId, freshToken, 200, 'SSE accepts replacement token');
  await expectAttachmentViewStatus(projectId, freshToken, 404, 'attachment view accepts replacement token before lookup');""",
)

replace_exact(
    "CHANGELOG.md",
    """### Changed

- 프로젝트 이름 입력 필드에 입력 예시(placeholder)를 추가하여 사용자 편의성을 개선했습니다.""",
    """### Security

- Centralized session JWT verification and database-backed `token_version`
  revocation across bearer middleware, calendar feeds, server-sent events, and
  attachment-view URL transports.

### Changed

- 프로젝트 이름 입력 필드에 입력 예시(placeholder)를 추가하여 사용자 편의성을 개선했습니다.""",
)
