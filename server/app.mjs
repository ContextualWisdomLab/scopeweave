// Security envelope for the ScopeWeave SaaS routes.
//
// The route implementation remains in app_routes.mjs so the client-IP trust
// boundary stays small, reviewable, and independently testable. Rate limiting
// is authoritative only in this envelope: the legacy route-module limiter is
// initialized disabled so spoofable left-side forwarding data cannot create a
// second, contradictory client bucket behind a trusted proxy.
import { Hono } from 'hono';
import { isIP } from 'node:net';

/**
 * Parse one explicit limiter setting without silently weakening protection.
 * Empty or absent values use the documented fallback; configured values must
 * be finite safe integers within the caller's accepted range.
 */
function parseSafeIntegerSetting(name, raw, fallback, minimum) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    const range = minimum === 0 ? 'a non-negative' : 'a positive';
    throw new Error(`${name} must be ${range} safe integer`);
  }
  return value;
}

/**
 * Return a stable IP spelling for trust comparisons and limiter keys.
 *
 * Node can expose an IPv4 connection accepted by an IPv6 dual-stack listener
 * as an IPv4-mapped address such as `::ffff:127.0.0.1`. Operators should be
 * able to configure the actual IPv4 proxy address once, rather than having to
 * predict the listener representation. Invalid values return null so they can
 * never become trusted identities.
 */
function canonicalIp(value) {
  const candidate = String(value ?? '').trim();
  const family = isIP(candidate);
  if (family === 0) return null;
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(candidate);
    if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  }
  return family === 6 ? candidate.toLowerCase() : candidate;
}

const configuredRateLimitMax = process.env.SCOPEWEAVE_RATE_LIMIT_MAX;
const RL_MAX = parseSafeIntegerSetting('SCOPEWEAVE_RATE_LIMIT_MAX', configuredRateLimitMax, 0, 0);
const RL_WINDOW_MS = parseSafeIntegerSetting(
  'SCOPEWEAVE_RATE_LIMIT_WINDOW_MS',
  process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS,
  60000,
  1,
);
const RL_BUCKET_LIMIT = parseSafeIntegerSetting(
  'SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX',
  process.env.SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX,
  10000,
  1,
);
const trustedProxyIps = new Set(
  String(process.env.SCOPEWEAVE_TRUSTED_PROXY_IPS || '')
    .split(',')
    .map(canonicalIp)
    .filter(Boolean)
);
const rlBuckets = new Map();
let overflowBucket;
let nextBucketSweepAt = 0;

// app_routes.mjs predates the transport-peer trust boundary and still contains
// its historical header-keyed limiter. Load it with that limiter disabled so
// only the security envelope below can consume rate-limit state. Restore the
// operator environment immediately after module initialization.
let routeApp;
try {
  process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '0';
  ({ app: routeApp } = await import('./app_routes.mjs'));
} finally {
  if (configuredRateLimitMax === undefined) delete process.env.SCOPEWEAVE_RATE_LIMIT_MAX;
  else process.env.SCOPEWEAVE_RATE_LIMIT_MAX = configuredRateLimitMax;
}

/**
 * Resolve the network peer that directly connected to the Node server.
 * In in-process tests or non-Node adapters where no socket exists, all such
 * requests deliberately share the fail-closed `local` bucket.
 */
function connectionPeerIp(c) {
  const peer = canonicalIp(c.env?.incoming?.socket?.remoteAddress);
  return peer || 'local';
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
    const hop = canonicalIp(forwarded[i]);
    if (!hop) return peer;
    if (!trustedProxyIps.has(hop)) return hop;
  }
  return peer;
}

/**
 * Return bounded fixed-window state for one client identity.
 *
 * The regular client map never grows beyond RL_BUCKET_LIMIT. Once that many
 * distinct identities are live, unseen clients share a separate fail-closed
 * overflow bucket. Expired regular buckets are swept at most once per window,
 * keeping both memory and sweep CPU bounded under high-cardinality traffic.
 */
function rateLimitBucket(key, now) {
  let bucket = rlBuckets.get(key);
  if (bucket?.resetAt <= now) {
    rlBuckets.delete(key);
    bucket = undefined;
  }
  if (bucket) return bucket;

  if (rlBuckets.size >= RL_BUCKET_LIMIT && now >= nextBucketSweepAt) {
    for (const [bucketKey, candidate] of rlBuckets) {
      if (candidate.resetAt <= now) rlBuckets.delete(bucketKey);
    }
    nextBucketSweepAt = now + RL_WINDOW_MS;
  }

  if (rlBuckets.size < RL_BUCKET_LIMIT) {
    bucket = { count: 0, resetAt: now + RL_WINDOW_MS };
    rlBuckets.set(key, bucket);
    return bucket;
  }

  if (!overflowBucket || overflowBucket.resetAt <= now) {
    overflowBucket = { count: 0, resetAt: now + RL_WINDOW_MS };
  }
  return overflowBucket;
}

export const app = new Hono();

if (RL_MAX > 0) {
  app.use('*', async (c, next) => {
    const key = rateLimitClientIp(c);
    const now = Date.now();
    const bucket = rateLimitBucket(key, now);
    bucket.count++;
    if (bucket.count > RL_MAX) {
      const retry = Math.ceil((bucket.resetAt - now) / 1000);
      return c.json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': String(retry) });
    }
    await next();
  });
}

app.route('/', routeApp);
