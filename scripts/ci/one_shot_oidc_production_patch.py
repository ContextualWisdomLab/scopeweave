#!/usr/bin/env python3
"""Replace ScopeWeave's unverified inline OIDC flow with the verified module."""

from __future__ import annotations

import re
from pathlib import Path


IMPORT_ANCHOR = "import { chat as orchestratorChat } from './orchestrator.mjs';\n"
OIDC_IMPORT = """import {
  OidcConfigurationError,
  oidcMock,
  authorizationUrl as createOidcAuthorizationUrl,
  exchangeAuthorizationCode,
} from './oidc.mjs';
"""
START_MARKER = "// ------------------------------------------------------------ SSO (OIDC)\n"
END_MARKER = "// Cross-project search: project names + task names, membership-scoped (tenant\n"

OIDC_BLOCK = r'''// ------------------------------------------------------------ SSO (OIDC)
// Production uses discovery, S256 PKCE, a nonce, provider JWKS verification,
// and exact issuer/audience/time checks. The local provider is explicit dev-only.
const oidcStates = new Map(); // state -> { verifier, nonce, redirectUri, exp }
const oidcCodes = new Map();  // dev-only: code -> { email, state, exp }
const OIDC_STATE_LIMIT = 10_000;

function pruneOidcState() {
  const now = Date.now();
  for (const [state, value] of oidcStates) {
    if (value.exp < now) oidcStates.delete(state);
  }
  for (const [code, value] of oidcCodes) {
    if (value.exp < now) oidcCodes.delete(code);
  }
}

function upsertSsoUser(email) {
  const normalizedEmail = String(email).trim().toLowerCase();
  let user = db.prepare('SELECT id, email, token_version FROM users WHERE email = ?').get(normalizedEmail);
  if (user) return user;
  db.exec('BEGIN');
  try {
    const uid = rowid(db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)')
      .run(normalizedEmail, hashPassword(randomBytes(24).toString('hex')), ''));
    const oid = rowid(db.prepare('INSERT INTO orgs(name,owner_id) VALUES(?,?)').run(`${normalizedEmail}'s workspace`, uid));
    db.prepare('INSERT INTO memberships(org_id,user_id,role) VALUES(?,?,?)').run(oid, uid, 'owner');
    db.exec('COMMIT');
    metrics.signups++;
    return { id: uid, email: normalizedEmail };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function oidcFailure(c, error) {
  if (!(error instanceof OidcConfigurationError)) throw error;
  return c.json({ error: error.code }, error.statusCode);
}

app.get('/api/auth/oidc/start', async (c) => {
  pruneOidcState();
  if (oidcStates.size >= OIDC_STATE_LIMIT) {
    return c.json({ error: 'oidc_state_capacity_exceeded' }, 429);
  }
  const origin = new URL(c.req.url).origin;
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const exp = Date.now() + 5 * 60 * 1000;

  if (oidcMock) {
    const redirectUri = `${origin}/api/auth/oidc/callback`;
    oidcStates.set(state, { verifier, nonce, redirectUri, exp });
    const email = c.req.query('email') || 'sso-user@example.com';
    const url = new URL(`${origin}/api/auth/oidc/mock/authorize`);
    url.searchParams.set('state', state);
    url.searchParams.set('email', email);
    return c.redirect(url.toString());
  }

  try {
    const authorization = await createOidcAuthorizationUrl({
      state,
      nonce,
      codeChallenge: challenge,
    });
    oidcStates.set(state, {
      verifier,
      nonce,
      redirectUri: authorization.redirectUri,
      exp,
    });
    return c.redirect(authorization.url);
  } catch (error) {
    return oidcFailure(c, error);
  }
});

// Explicit development provider. It is unreachable unless SCOPEWEAVE_DEV=1
// and no production issuer is configured.
app.get('/api/auth/oidc/mock/authorize', (c) => {
  if (!oidcMock) return c.json({ error: 'mock disabled' }, 404);
  pruneOidcState();
  const state = c.req.query('state');
  const pending = oidcStates.get(state);
  if (!pending || pending.exp < Date.now()) {
    return c.json({ error: 'invalid or expired state' }, 400);
  }
  const email = String(c.req.query('email') || '').trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return c.json({ error: 'invalid email' }, 400);
  }
  const code = randomBytes(32).toString('base64url');
  oidcCodes.set(code, { email, state, exp: pending.exp });
  const url = new URL(pending.redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return c.redirect(url.toString());
});

app.get('/api/auth/oidc/callback', async (c) => {
  pruneOidcState();
  const state = c.req.query('state');
  const code = c.req.query('code');
  const pending = oidcStates.get(state);
  if (!pending || pending.exp < Date.now()) {
    return c.json({ error: 'invalid or expired state' }, 400);
  }
  oidcStates.delete(state); // single-use before provider I/O

  let identity;
  if (oidcMock) {
    const authorizationCode = oidcCodes.get(code);
    oidcCodes.delete(code);
    if (
      !authorizationCode
      || authorizationCode.exp < Date.now()
      || authorizationCode.state !== state
    ) {
      return c.json({ error: 'invalid code' }, 400);
    }
    identity = { email: authorizationCode.email };
  } else {
    try {
      identity = await exchangeAuthorizationCode({
        code,
        codeVerifier: pending.verifier,
        nonce: pending.nonce,
        redirectUri: pending.redirectUri,
      });
    } catch (error) {
      return oidcFailure(c, error);
    }
  }

  const user = upsertSsoUser(identity.email);
  const token = signToken({
    sub: user.id,
    email: user.email,
    tv: user.token_version || 0,
  });
  // Return the token in the fragment rather than the query so intermediaries do
  // not receive it; the client stores the token and immediately cleans the URL.
  return c.redirect(`/#token=${token}`);
});

'''


def main() -> int:
    """Apply the exact import and OIDC route replacement."""
    repo_root = Path(__file__).resolve().parents[2]
    app_path = repo_root / "server/app.mjs"
    source = app_path.read_text(encoding="utf-8")
    if source.count(IMPORT_ANCHOR) != 1:
        raise RuntimeError("orchestrator import anchor drifted")
    if "from './oidc.mjs';" not in source:
        source = source.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + OIDC_IMPORT, 1)

    pattern = re.compile(
        re.escape(START_MARKER) + r".*?(?=" + re.escape(END_MARKER) + r")",
        re.DOTALL,
    )
    source, count = pattern.subn(OIDC_BLOCK, source, count=1)
    if count != 1:
        raise RuntimeError(f"expected one inline OIDC block, found {count}")
    forbidden = (
        "const oidcMock = !OIDC.issuer",
        "verify the id_token signature via the issuer JWKS before prod",
        "String(tok.id_token).split('.')[1]",
    )
    if any(marker in source for marker in forbidden):
        raise RuntimeError("unverified inline OIDC path remains after patch")
    app_path.write_text(source, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
