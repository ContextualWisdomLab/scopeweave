import assert from 'node:assert/strict';

process.env.SCOPEWEAVE_RATE_LIMIT_MAX = '1';
process.env.SCOPEWEAVE_RATE_LIMIT_WINDOW_MS = '60000';
process.env.SCOPEWEAVE_RATE_LIMIT_BUCKETS_MAX = '8';
process.env.SCOPEWEAVE_TRUSTED_PROXY_IPS = 'fe80::1%eth0';

const { createRateLimitMiddleware } = await import('../../server/rate_limit.mjs?scoped-ipv6=1');
const middleware = createRateLimitMiddleware();

function context(forwardedFor) {
  const state = new Map();
  return {
    env: { incoming: { socket: { remoteAddress: 'fe80::1%eth0' } } },
    req: {
      method: 'GET',
      path: '/probe',
      header(name) { return name.toLowerCase() === 'x-forwarded-for' ? forwardedFor : ''; },
      query() { return undefined; },
    },
    get(key) { return state.get(key); },
    set(key, value) { state.set(key, value); },
    json(body, status, headers) { return new Response(JSON.stringify(body), { status, headers }); },
  };
}

let admitted = false;
await middleware(context('198.51.100.1'), async () => { admitted = true; });
assert.equal(admitted, true, 'scoped trusted peer admits its first forwarded client without URL parsing failure');

admitted = false;
await middleware(context('198.51.100.2'), async () => { admitted = true; });
assert.equal(admitted, true, 'the same scoped trusted peer can distinguish a second forwarded client');

console.log('scoped IPv6 trusted-peer rate-limit contract passed');
