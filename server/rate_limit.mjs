import { isIP } from 'node:net';

export const RATE_LIMIT_APPLIED_CONTEXT_KEY = 'scopeweaveRateLimitApplied';

/**
 * Parse one explicit rate-limit setting without silently weakening protection.
 *
 * Empty or absent values use the documented fallback. Configured values must be
 * finite safe integers within the caller's accepted range so a typo cannot
 * accidentally disable or effectively unbound the limiter.
 *
 * @param {string} name Environment-variable name used in startup errors.
 * @param {unknown} raw Operator-provided value.
 * @param {number} fallback Value used when the setting is absent or empty.
 * @param {number} minimum Smallest accepted integer.
 * @returns {number} Validated integer setting.
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
 * Return one canonical IP spelling for trust comparisons and limiter keys.
 *
 * Equivalent IPv6 spellings collapse to one identity. IPv4-mapped IPv6 values
 * are reduced to the underlying IPv4 address. Invalid text returns null and can
 * never become a trusted proxy or attacker-selected bucket key.
 *
 * @param {unknown} value Candidate IP text.
 * @returns {string|null} Canonical address, or null when invalid.
 */
function canonicalIp(value) {
  const candidate = String(value ?? '').trim();
  const family = isIP(candidate);
  if (family === 0) return null;
  if (family === 4) return candidate;

  const normalized = new URL(`http://[${candidate}]/`).hostname.slice(1, -1).toLowerCase();
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(normalized);
  if (!mapped) return normalized;

  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function connectionPeerIp(c) {
  const peer = canonicalIp(c.env?.incoming?.socket?.remoteAddress);
  return peer || 'local';
}

function clientIdentity(c, trustedProxyIps) {
  const peer = connectionPeerIp(c);
  if (!trustedProxyIps.has(peer)) return peer;

  const forwarded = String(c.req.header('x-forwarded-for') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (forwarded.length === 0) return peer;

  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    const hop = canonicalIp(forwarded[index]);
    if (!hop) return peer;
    if (!trustedProxyIps.has(hop)) return hop;
  }
  return peer;
}

/**
 * Create process-local observability hooks for rate-limited requests.
 *
 * Blocked requests do not enter the route graph's ordinary logger/counters. The
 * returned hooks record only that missing 429 delta and fold it into existing
 * JSON or Prometheus metrics when `/api/metrics` is read. The hooks never log
 * client addresses, credentials, bodies, or forwarding headers.
 *
 * @returns {{onBlocked: Function, afterNext: Function}} Middleware hooks.
 */
export function createRateLimitObservability() {
  let rateLimitedRequests = 0;
  const quietLogs = String(process.env.SCOPEWEAVE_DB || '').includes(':memory:');

  return Object.freeze({
    onBlocked(c, { startedAt }) {
      rateLimitedRequests += 1;
      if (!quietLogs) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          method: c.req.method,
          path: c.req.path,
          status: 429,
          ms: Date.now() - startedAt,
        }));
      }
    },

    async afterNext(c) {
      if (c.req.path !== '/api/metrics' || c.res.status !== 200 || rateLimitedRequests === 0) return;

      const headers = new Headers(c.res.headers);
      headers.delete('content-length');
      if (c.req.query('format') === 'prometheus') {
        const text = await c.res.text();
        const adjusted = text.split('\n').map((line) => {
          const match = /^(scopeweave_(?:requests|s4xx))\s+(-?\d+(?:\.\d+)?)$/u.exec(line);
          if (!match) return line;
          return `${match[1]} ${Number(match[2]) + rateLimitedRequests}`;
        }).join('\n');
        c.res = new Response(adjusted, { status: 200, headers });
        return;
      }

      const snapshot = await c.res.json();
      if (typeof snapshot?.requests === 'number') snapshot.requests += rateLimitedRequests;
      if (typeof snapshot?.s4xx === 'number') snapshot.s4xx += rateLimitedRequests;
      c.res = new Response(JSON.stringify(snapshot), { status: 200, headers });
    },
  });
}

/**
 * Build the authoritative fixed-window rate-limit middleware for one boundary.
 *
 * The immediate transport peer anchors trust. `X-Forwarded-For` is considered
 * only when that peer is explicitly trusted, then walked right-to-left until
 * the first valid untrusted client hop. In-memory state is bounded; unseen
 * identities at capacity share one fail-closed overflow bucket. A context flag
 * prevents a nested supported boundary from applying the same policy twice.
 *
 * @param {{onBlocked?: Function, afterNext?: Function}} hooks Optional lifecycle hooks.
 * @returns {Function} Hono middleware.
 */
export function createRateLimitMiddleware({ onBlocked, afterNext } = {}) {
  const maxRequests = parseSafeIntegerSetting(
    'SCOPEWEAVE_RATE_LIMIT_MAX',
    process.env.SCOPEWEAVE_RATE_LIMIT_MAX,
    0,
    0,
  );
  const windowMs = parseSafeIntegerSetting(
    'SCOPEWEAVE_RATE_LIMIT_WINDOW_MS',
    process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS,
    60000,
    1,
  );
  const bucketLimit = parseSafeIntegerSetting(
    'SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX',
    process.env.SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX,
    10000,
    1,
  );
  const trustedProxyIps = new Set(
    String(process.env.SCOPEWEAVE_TRUSTED_PROXY_IPS || '')
      .split(',')
      .map(canonicalIp)
      .filter(Boolean),
  );
  const buckets = new Map();
  let overflowBucket;
  let nextBucketSweepAt = 0;

  function bucketFor(key, now) {
    let bucket = buckets.get(key);
    if (bucket?.resetAt <= now) {
      buckets.delete(key);
      bucket = undefined;
    }
    if (bucket) return bucket;

    if (buckets.size >= bucketLimit && now >= nextBucketSweepAt) {
      for (const [bucketKey, candidate] of buckets) {
        if (candidate.resetAt <= now) buckets.delete(bucketKey);
      }
      nextBucketSweepAt = now + windowMs;
    }

    if (buckets.size < bucketLimit) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
      return bucket;
    }

    if (!overflowBucket || overflowBucket.resetAt <= now) {
      overflowBucket = { count: 0, resetAt: now + windowMs };
    }
    return overflowBucket;
  }

  return async function rateLimitMiddleware(c, next) {
    if (c.get(RATE_LIMIT_APPLIED_CONTEXT_KEY)) {
      await next();
      if (afterNext) await afterNext(c);
      return;
    }

    c.set(RATE_LIMIT_APPLIED_CONTEXT_KEY, true);
    if (maxRequests > 0) {
      const startedAt = Date.now();
      const now = Date.now();
      const bucket = bucketFor(clientIdentity(c, trustedProxyIps), now);
      bucket.count += 1;
      if (bucket.count > maxRequests) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        if (onBlocked) await onBlocked(c, { startedAt, retryAfterSeconds });
        return c.json(
          { error: 'rate limit exceeded' },
          429,
          { 'Retry-After': String(retryAfterSeconds) },
        );
      }
    }

    await next();
    if (afterNext) await afterNext(c);
  };
}
