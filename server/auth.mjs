// Auth primitives. ponytail: node:crypto only — no auth lib dependency.
// Passwords: scrypt. Tokens: HS256 JWT with a PINNED algorithm (no header-alg
// trust → immune to alg-confusion). This is a security boundary; do not simplify.
import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { db } from './db.mjs';

/** Maximum lifetime for a general ScopeWeave session token, in seconds. */
const MAX_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Generate a one-time-visible ScopeWeave personal access token.
 *
 * Only the SHA-256 hash is suitable for persistence. The `full` value must be
 * shown exactly once, while `prefix` is safe for later identification.
 *
 * @returns {{full:string,prefix:string,hash:string}} Token material and safe metadata.
 */
export function generateApiToken() {
  const full = `swk_${randomBytes(24).toString('base64url')}`;
  return { full, prefix: full.slice(0, 12), hash: createHash('sha256').update(full).digest('hex') };
}

/**
 * Hash a personal access token for constant-shape database lookup.
 *
 * @param {unknown} full - Full token supplied by a client.
 * @returns {string} Lowercase hexadecimal SHA-256 digest.
 */
export function hashApiToken(full) {
  return createHash('sha256').update(String(full)).digest('hex');
}

// Fail closed: never mint or verify tokens with a missing/weak/placeholder secret.
// Require ≥32 non-whitespace characters so compose-unexpanded literals and short
// defaults cannot silently ship.
const SECRET = process.env.SCOPEWEAVE_JWT_SECRET;
if (
  typeof SECRET !== 'string'
  || SECRET.replace(/\s/g, '').length < 32
  || SECRET.includes('${SCOPEWEAVE_JWT_SECRET')
) {
  throw new Error('SCOPEWEAVE_JWT_SECRET must be set to at least 32 non-whitespace characters');
}

/**
 * Hash a password with a fresh random salt using Node's scrypt implementation.
 *
 * Non-string values are normalized to an empty string so an untyped request
 * cannot crash the process. API boundaries must still reject non-string inputs.
 *
 * @param {unknown} pw - Password value to hash.
 * @returns {string} Persistable `salt:hash` representation.
 */
export function hashPassword(pw) {
  const password = typeof pw === 'string' ? pw : '';
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a candidate password against a stored scrypt representation.
 *
 * Non-string candidates and malformed stored values fail closed. Equal-length
 * digests are compared with `timingSafeEqual` to avoid content-dependent timing.
 *
 * @param {unknown} pw - Candidate password.
 * @param {unknown} stored - Persisted `salt:hash` representation.
 * @returns {boolean} Whether the candidate matches the stored password hash.
 */
export function verifyPassword(pw, stored) {
  if (typeof pw !== 'string') return false;
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = scryptSync(pw, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return test.length === known.length && timingSafeEqual(test, known);
}

/**
 * Serialize a JSON value using the unpadded base64url form required by JWT.
 *
 * @param {unknown} value - JSON-serializable value.
 * @returns {string} Base64url-encoded JSON.
 */
const b64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Determine whether a decoded JWT segment is a non-array JSON object.
 *
 * @param {unknown} value - Decoded JSON value.
 * @returns {value is Record<string, unknown>} Whether the value is a claims object.
 */
function isClaimsObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Sign a ScopeWeave session JWT with pinned HS256 semantics.
 *
 * Session tokens are minted only for a positive safe-integer user subject and a
 * non-negative safe-integer token version. The lifetime must be a positive safe
 * integer no greater than seven days, so an internal caller cannot create an
 * immortal, already-expired, excessively long-lived, or numerically imprecise
 * general session token. Narrower credentials use the separate access-grant
 * design tracked in issue #413 rather than extending this lifetime.
 *
 * @param {Record<string, unknown>} payload - Session claims to include.
 * @param {number} [ttlSec=604800] - Token lifetime in seconds, at most seven days.
 * @returns {string} Signed compact JWT.
 * @throws {TypeError|RangeError} If the payload, subject, token version, or lifetime is invalid.
 */
export function signToken(payload, ttlSec = MAX_SESSION_TTL_SECONDS) {
  if (!isClaimsObject(payload)) throw new TypeError('session claims must be an object');
  if (!Number.isSafeInteger(payload.sub) || payload.sub < 1) {
    throw new TypeError('session subject must be a positive safe integer');
  }
  if (!Number.isSafeInteger(payload.tv) || payload.tv < 0) {
    throw new TypeError('session token version must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(ttlSec) || ttlSec < 1) {
    throw new RangeError('session lifetime must be a positive safe integer');
  }
  if (ttlSec > MAX_SESSION_TTL_SECONDS) {
    throw new RangeError(`session maximum lifetime is ${MAX_SESSION_TTL_SECONDS} seconds`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson({ ...payload, iat: now, exp: now + ttlSec });
  const sig = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/**
 * Verify a signed ScopeWeave session JWT and enforce database-backed revocation.
 *
 * The verifier recomputes an HS256 signature before parsing claims, then requires
 * the signed header to declare the same pinned algorithm and JWT type. Session
 * claims must contain a positive safe-integer subject, a future safe-integer
 * expiry, and a non-negative safe-integer token version. The referenced user must
 * exist and the token version must equal the current database value. Every
 * session-JWT transport uses this function so `logout-all` cannot be bypassed by
 * calendar, SSE, attachment-view, or bearer-token routes.
 *
 * @param {unknown} token - Compact JWT supplied by a client.
 * @returns {Record<string, unknown>} Verified session claims.
 * @throws {Error} If structure, signature, header, claims, expiry, user, or revocation checks fail.
 */
export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [header, body, sig] = parts;

  // Recompute HS256 first; do not parse or trust attacker-controlled claims
  // before the compact representation has authenticated successfully.
  const expected = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  const actualSignature = Buffer.from(sig);
  const expectedSignature = Buffer.from(expected);
  if (
    actualSignature.length !== expectedSignature.length
    || !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error('bad signature');
  }

  const headerClaims = JSON.parse(Buffer.from(header, 'base64url').toString());
  if (!isClaimsObject(headerClaims)) throw new Error('invalid token header');
  if (headerClaims.alg !== 'HS256') throw new Error('invalid token algorithm');
  if (headerClaims.typ !== 'JWT') throw new Error('invalid token type');

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!isClaimsObject(payload)) throw new Error('invalid session claims');
  if (!Number.isSafeInteger(payload.sub) || payload.sub < 1) {
    throw new Error('invalid session subject');
  }
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('expired or invalid session expiry');
  }
  if (!Number.isSafeInteger(payload.tv) || payload.tv < 0) {
    throw new Error('invalid token version');
  }

  const user = db.prepare('SELECT token_version FROM users WHERE id = ?').get(payload.sub);
  if (!user) throw new Error('unknown session subject');
  if (payload.tv !== user.token_version) throw new Error('revoked session');
  return payload;
}
