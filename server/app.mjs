// Security envelope for the ScopeWeave SaaS routes.
//
// The route implementation remains in app_routes.mjs so the client-IP trust
// boundary stays small, reviewable, and independently testable. The outer
// limiter is authoritative for abuse protection; the route module's historic
// limiter remains in place for backward compatibility until that code is
// retired in a later focused change.
import { Hono } from 'hono';
import { isIP } from 'node:net';
import { app as routeApp } from './app_routes.mjs';

export * from './app_routes.mjs';

const RL_MAX = Number(process.env.SCOPEWEAVE_RATE_LIMIT_MAX) || 0;
const RL_WINDOW_MS = Number(process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS) || 60000;
const trustedProxyIps = new Set(
  String(process.env.SCOPEWEAVE_TRUSTED_PROXY_IPS || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => isIP(value) !== 0)
);
const rlBuckets = new Map();

/**
 * Resolve the network peer that directly connected to the Node server.
 * In in-process tests or non-Node adapters where no socket exists, all such
 * requests deliberately share the fail-closed `local` bucket.
 */
function connectionPeerIp(c) {
  const raw = c.env?.incoming?.socket?.remoteAddress;
  if (typeof raw !== 'string') return 'local';
  const candidate = raw.trim();
  return isIP(candidate) ? candidate : 'local';
}

/**
 * Resolve a rate-limit identity without trusting caller-controlled forwarding
 * headers. Forwarded hops are considered only when the immediate network peer
 * is explicitly trusted, then walked right-to-left until the first untrusted
 * valid IP. Invalid forwarding evidence fails closed to the actual peer.
 */
function rateLimitClientIp(c) {
  const peer = connectionPeerIp(c);
  if (!trustedProxyIps.has(peer)) return peer;

  const forwarded = String(c.req.header('x-forwarded-for') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (forwarded.length === 0) return peer;

  for (let i = forwarded.length - 1; i >= 0; i--) {
    const hop = forwarded[i];
    if (!isIP(hop)) return peer;
    if (!trustedProxyIps.has(hop)) return hop;
  }
  return peer;
}

export const app = new Hono();

if (RL_MAX > 0) {
  app.use('*', async (c, next) => {
    const key = rateLimitClientIp(c);
    const now = Date.now();
    let bucket = rlBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + RL_WINDOW_MS };
      rlBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > RL_MAX) {
      const retry = Math.ceil((bucket.resetAt - now) / 1000);
      return c.json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': String(retry) });
    }
    await next();
  });
}

app.route('/', routeApp);
