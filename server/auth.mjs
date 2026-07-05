// Auth primitives. ponytail: node:crypto only — no auth lib dependency.
// Passwords: scrypt. Tokens: HS256 JWT with a PINNED algorithm (no header-alg
// trust → immune to alg-confusion). This is a security boundary; do not simplify.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const SECRET = process.env.SCOPEWEAVE_JWT_SECRET || 'dev-insecure-secret-change-me';
if (SECRET === 'dev-insecure-secret-change-me') {
  console.warn('[auth] INSECURE dev JWT secret in use — set SCOPEWEAVE_JWT_SECRET in production');
}

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = scryptSync(pw, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return test.length === known.length && timingSafeEqual(test, known);
}

const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signToken(payload, ttlSec = 60 * 60 * 24 * 7) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson({ ...payload, iat: now, exp: now + ttlSec });
  const sig = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [header, body, sig] = parts;
  // Recompute HS256 signature; never read/trust the header's declared alg.
  const expected = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired');
  return payload;
}
