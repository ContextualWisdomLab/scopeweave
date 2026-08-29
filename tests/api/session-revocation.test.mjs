// Security invariant: logout-all revocation and strict session-claim validation
// must apply uniformly to every JWT transport. Calendar clients and EventSource
// cannot reliably send Authorization headers, so query-token routes must share
// the same fail-closed verifier as bearer middleware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';
process.env.SCOPEWEAVE_DB = ':memory:';
process.env.SCOPEWEAVE_JWT_SECRET = JWT_SECRET;

const { app } = await import('../../server/app.mjs');
const { signToken } = await import('../../server/auth.mjs');
const { db } = await import('../../server/db.mjs');

const req = (path, opts = {}) =>
  app.request(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
const body = (value) => JSON.stringify(value);
const encodeSegment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Create a correctly signed but intentionally unvalidated compact JWT.
 *
 * Production code cannot mint malformed session claims through `signToken`.
 * This test-only signer is therefore required to exercise the verifier's
 * hostile-input boundary without weakening the production signer.
 *
 * @param {unknown} payload - Raw signed payload value.
 * @param {unknown} [headerClaims] - Raw signed header value.
 * @returns {string} Compact HS256 token signed with the test secret.
 */
function signUnsafe(
  payload,
  headerClaims = { alg: 'HS256', typ: 'JWT' },
) {
  const header = encodeSegment(headerClaims);
  const encodedBody = encodeSegment(payload);
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${encodedBody}`)
    .digest('base64url');
  return `${header}.${encodedBody}.${signature}`;
}

async function expectStreamStatus(projectId, token, status, message) {
  const response = await req(
    `/api/projects/${projectId}/stream?token=${encodeURIComponent(token)}`,
  );
  assert.equal(response.status, status, message);
  await response.body?.cancel?.();
}

async function expectCalendarStatus(projectId, token, status, message) {
  const response = await req(
    `/api/projects/${projectId}/calendar.ics?token=${encodeURIComponent(token)}`,
  );
  assert.equal(response.status, status, message);
}

async function expectAttachmentViewStatus(projectId, token, status, message) {
  const response = await req(
    `/api/projects/${projectId}/attachments/missing/view?token=${encodeURIComponent(token)}`,
  );
  assert.equal(response.status, status, message);
}

async function expectBearerStatus(token, status, message) {
  const response = await req('/api/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, status, message);
}

/**
 * Assert that one invalid session token is rejected by every supported transport.
 *
 * @param {number} projectId - Accessible project used by URL-token routes.
 * @param {string} token - Invalid or revoked compact JWT.
 * @param {string} label - Diagnostic label for assertion messages.
 * @returns {Promise<void>} Resolves after all four transport assertions.
 */
async function expectRejectedEverywhere(projectId, token, label) {
  await expectBearerStatus(token, 401, `bearer rejects ${label}`);
  await expectCalendarStatus(projectId, token, 401, `calendar rejects ${label}`);
  await expectStreamStatus(projectId, token, 401, `SSE rejects ${label}`);
  await expectAttachmentViewStatus(projectId, token, 401, `attachment view rejects ${label}`);
}

/**
 * Fault-inject a token-version change between the verifier read and a transport's
 * defense-in-depth read, modeling a concurrent logout-all from another process.
 *
 * Both reads are synchronous in this process, so the test interposes only the
 * exact token-version query instead of weakening production verification. The
 * first read remains the real durable value used by `verifyToken`; the second
 * read reports the next version, as an external writer could after verification.
 * All other statement methods are delegated to the real SQLite statement so
 * the fault seam cannot accidentally narrow the adapter surface under test.
 *
 * @param {() => Promise<Response>} runRequest - Request that authenticates one JWT.
 * @param {string} label - Diagnostic label for assertions.
 * @returns {Promise<void>} Resolves after the request is proven fail-closed.
 */
async function expectPostVerificationRevocationRejected(runRequest, label) {
  const originalPrepare = db.prepare;
  let tokenVersionReads = 0;

  db.prepare = function prepareWithRevocationFault(sql) {
    const statement = originalPrepare.call(this, sql);
    if (sql !== 'SELECT token_version FROM users WHERE id = ?') return statement;

    return new Proxy(statement, {
      get(target, property) {
        if (property === 'get') {
          return (...args) => {
            const row = target.get(...args);
            tokenVersionReads += 1;
            if (tokenVersionReads === 2 && row) {
              return { ...row, token_version: row.token_version + 1 };
            }
            return row;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  try {
    const response = await runRequest();
    assert.equal(response.status, 401, `${label} rejects post-verification revocation`);
    assert.equal(
      tokenVersionReads,
      2,
      `${label} performs verifier and transport token-version reads`,
    );
  } finally {
    db.prepare = originalPrepare;
  }
}

test('session signer rejects malformed claims before minting a token', () => {
  assert.throws(() => signToken(null), /claims must be an object/);
  assert.throws(() => signToken([], 60), /claims must be an object/);
  assert.throws(() => signToken({ sub: '1', tv: 0 }), /subject/);
  assert.throws(() => signToken({ sub: 0, tv: 0 }), /subject/);
  assert.throws(
    () => signToken({ sub: Number.MAX_SAFE_INTEGER + 1, tv: 0 }),
    /subject/,
  );
  assert.throws(() => signToken({ sub: 1, tv: '0' }), /token version/);
  assert.throws(() => signToken({ sub: 1, tv: -1 }), /token version/);
  assert.throws(
    () => signToken({ sub: 1, tv: Number.MAX_SAFE_INTEGER + 1 }),
    /token version/,
  );
  assert.throws(() => signToken({ sub: 1, tv: 0 }, '60'), /lifetime/);
  assert.throws(() => signToken({ sub: 1, tv: 0 }, 0), /lifetime/);
  assert.throws(() => signToken({ sub: 1, tv: 0 }, 1.5), /lifetime/);
  assert.throws(
    () => signToken({ sub: 1, tv: 0 }, 60 * 60 * 24 * 7 + 1),
    /maximum lifetime/,
  );
  assert.throws(
    () => signToken({ sub: 1, tv: 0 }, Number.MAX_SAFE_INTEGER),
    /maximum lifetime/,
  );
});

test('logout-all and strict JWT validation cover every session transport', async () => {
  let response = await req('/api/auth/signup', {
    method: 'POST',
    body: body({
      email: 'revocation-test@scopeweave.test',
      password: 'password123',
      name: 'Revocation Test',
    }),
  });
  assert.equal(response.status, 200, 'signup succeeds');
  const tokenA = (await response.json()).token;

  const authA = { authorization: `Bearer ${tokenA}` };
  response = await req('/api/me', { headers: authA });
  assert.equal(response.status, 200, 'current session resolves the user');
  const userId = (await response.json()).user.id;

  response = await req('/api/projects', {
    method: 'POST',
    headers: authA,
    body: body({ name: 'Revocation Probe' }),
  });
  assert.equal(response.status, 200, 'project creation succeeds');
  const projectId = (await response.json()).id;

  response = await req('/api/auth/login', {
    method: 'POST',
    body: body({
      email: 'revocation-test@scopeweave.test',
      password: 'password123',
    }),
  });
  assert.equal(response.status, 200, 'second-device login succeeds');
  const tokenB = (await response.json()).token;

  const now = Math.floor(Date.now() / 1000);
  const validClaims = { sub: userId, tv: 0, iat: now, exp: now + 3_600 };
  const malformedTokens = [
    ['malformed compact token', 'not-a-jwt'],
    ['invalid signature', `${tokenA.split('.').slice(0, 2).join('.')}.x`],
    ['array header', signUnsafe(validClaims, [])],
    ['non-HS256 header', signUnsafe(validClaims, { alg: 'none', typ: 'JWT' })],
    ['non-JWT type', signUnsafe(validClaims, { alg: 'HS256', typ: 'JWS' })],
    ['array claims', signUnsafe([])],
    ['missing subject', signUnsafe({ tv: 0, iat: now, exp: now + 3_600 })],
    ['string subject', signUnsafe({ ...validClaims, sub: '1' })],
    ['zero subject', signUnsafe({ ...validClaims, sub: 0 })],
    ['missing expiry', signUnsafe({ sub: userId, tv: 0, iat: now })],
    ['string expiry', signUnsafe({ ...validClaims, exp: String(now + 3_600) })],
    ['expired claim', signUnsafe({ ...validClaims, exp: now })],
    ['missing token version', signUnsafe({ sub: userId, iat: now, exp: now + 3_600 })],
    ['null token version', signUnsafe({ ...validClaims, tv: null })],
    ['boolean token version', signUnsafe({ ...validClaims, tv: false })],
    ['string token version', signUnsafe({ ...validClaims, tv: '0' })],
    ['fractional token version', signUnsafe({ ...validClaims, tv: 0.5 })],
    ['negative token version', signUnsafe({ ...validClaims, tv: -1 })],
    ['unsafe token version', signUnsafe({ ...validClaims, tv: Number.MAX_SAFE_INTEGER + 1 })],
  ];
  for (const [label, malformedToken] of malformedTokens) {
    await expectRejectedEverywhere(projectId, malformedToken, label);
  }

  const missingUserToken = signToken({ sub: userId + 1_000_000, tv: 0 });
  await expectRejectedEverywhere(projectId, missingUserToken, 'signed token for a missing user');

  // A cryptographically valid token for a real user must still fail closed when
  // its version does not equal the durable account version. Exercise this
  // boundary directly rather than relying only on the later logout transition.
  const mismatchedVersionToken = signToken({ sub: userId, tv: 1 });
  await expectRejectedEverywhere(projectId, mismatchedVersionToken, 'signed token with mismatched token version');

  // Model a separate ScopeWeave process committing logout-all after this process
  // completes verification but before its transport-specific second read. Both
  // bearer middleware and attachment query-token access must fail closed.
  await expectPostVerificationRevocationRejected(
    () => req('/api/me', { headers: authA }),
    'bearer middleware',
  );
  await expectPostVerificationRevocationRejected(
    () => req(
      `/api/projects/${projectId}/attachments/missing/view?token=${encodeURIComponent(tokenA)}`,
    ),
    'attachment query-token route',
  );

  await expectBearerStatus(tokenA, 200, 'bearer accepts token A before revocation');
  await expectBearerStatus(tokenB, 200, 'bearer accepts token B before revocation');
  await expectCalendarStatus(projectId, tokenA, 200, 'calendar accepts token A before revocation');
  await expectCalendarStatus(projectId, tokenB, 200, 'calendar accepts token B before revocation');
  await expectStreamStatus(projectId, tokenA, 200, 'SSE accepts token A before revocation');
  await expectStreamStatus(projectId, tokenB, 200, 'SSE accepts token B before revocation');
  await expectAttachmentViewStatus(projectId, tokenA, 404, 'attachment view authenticates token A before lookup');
  await expectAttachmentViewStatus(projectId, tokenB, 404, 'attachment view authenticates token B before lookup');

  response = await req('/api/auth/logout-all', {
    method: 'POST',
    headers: authA,
  });
  assert.equal(response.status, 200, 'logout-all succeeds');
  const freshToken = (await response.json()).token;

  for (const [label, staleToken] of [['A', tokenA], ['B', tokenB]]) {
    await expectRejectedEverywhere(projectId, staleToken, `stale token ${label}`);
  }

  await expectBearerStatus(freshToken, 200, 'bearer accepts replacement token');
  await expectCalendarStatus(projectId, freshToken, 200, 'calendar accepts replacement token');
  await expectStreamStatus(projectId, freshToken, 200, 'SSE accepts replacement token');
  await expectAttachmentViewStatus(projectId, freshToken, 404, 'attachment view accepts replacement token before lookup');
});