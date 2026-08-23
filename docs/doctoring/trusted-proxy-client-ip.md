# Trusted proxy client-IP boundary

## Status

**Active implementation evidence for PR #587.** This note records the security
reasoning and primary/authoritative references for ScopeWeave's rate-limit
client-identity boundary. It does not claim certification.

## Decision

Security-sensitive client identity must begin with the transport peer that
actually connected to the Node process. A caller-supplied `X-Forwarded-For`
header is ignored unless that immediate peer is explicitly listed in
`SCOPEWEAVE_TRUSTED_PROXY_IPS`.

When the immediate peer is trusted, ScopeWeave parses the forwarding chain from
right to left. Explicitly trusted proxy hops are skipped. The first untrusted,
syntactically valid IP becomes the rate-limit identity. Missing, malformed, or
all-trusted forwarding evidence fails closed to the actual peer. In adapters
where the socket peer is unavailable, requests share one `local` bucket rather
than accepting an unauthenticated forwarding value.

Only the security envelope in `server/app.mjs` is allowed to consume rate-limit
state. The older route-module limiter is initialized disabled when loaded by the
production envelope. Keeping two active limiters would let an attacker place a
victim address on the spoofable left side of an appended forwarding chain and
consume the victim's legacy bucket even though the trusted-boundary limiter had
correctly attributed the request to the attacker's nearest hop.

This is intentionally an allow-list trust model. It avoids treating a header
that an Internet client can normally set itself as authenticated evidence. The
operator contract in `docs/deploy.md` therefore requires direct access to the
backend to be denied before proxy addresses are added to the trust list.

## Acceptance trace

`tests/api/ratelimit.test.mjs` exercises both boundaries:

1. in-process/untrusted requests exhaust one bucket even when the caller changes
   `X-Forwarded-For`;
2. an actual Node loopback connection is configured as a trusted ingress;
3. changing spoofable left-side forwarding values while keeping the nearest
   untrusted client hop fixed still returns `429` after the configured limit;
4. a different nearest client hop receives a separate bucket;
5. repeated attacker requests with a spoofed victim address on the left do not
   consume the victim's rate-limit bucket;
6. trusted proxy hops are skipped right-to-left;
7. missing, malformed, and all-trusted forwarding evidence falls back to the
   transport peer.

The original bypass RED evidence was the hosted Server Tests failure at
contributor head `c4a3b2f6429634c4165f7efdc71734384241e574`: the spoofed
forwarding value returned `200` where the regression required `429`.

The cross-client poisoning RED evidence was Server Tests run `32614096313` on
the merge result containing contributor head
`dc2fe13b1825975bc38459862f48e2c645351924`: a legitimate victim request
returned `429` where the regression required `200`. The subsequent product fix
is on the same contributor branch; exact-head gate acceptance remains separate
from this behavioral regression evidence.

## References (APA 7)

Hono. (n.d.). *Node.js*. https://hono.dev/docs/getting-started/nodejs

MDN Web Docs. (2025, July 4). *X-Forwarded-For header*. Mozilla. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For

Petersson, A., & Nilsson, M. (2014). *Forwarded HTTP extension* (RFC 7239). Internet Engineering Task Force. https://doi.org/10.17487/RFC7239
