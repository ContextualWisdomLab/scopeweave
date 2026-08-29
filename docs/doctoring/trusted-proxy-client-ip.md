# Trusted proxy client-IP boundary

## Status

**Active implementation evidence for PR #587.** This note records the security
reasoning and primary/authoritative references for ScopeWeave's rate-limit
client-identity boundary. It does not claim certification or protected-`develop`
shipment.

## Decision

Security-sensitive client identity must begin with the transport peer that
actually connected to the Node process. A caller-supplied `X-Forwarded-For`
header is ignored unless that immediate peer is explicitly listed in
`SCOPEWEAVE_TRUSTED_PROXY_IPS`.

Before trust comparison, ScopeWeave canonicalizes valid Node peer and forwarded
IP spellings. In particular, Node may expose an IPv4 connection accepted by an
IPv6 dual-stack listener as a dotted IPv4-mapped IPv6 address such as
`::ffff:127.0.0.1`. ScopeWeave maps that representation to the underlying IPv4
address before trust lookup and limiter-key selection. An operator can therefore
configure the actual IPv4 ingress address once rather than having to predict
whether a deployment listener will surface `127.0.0.1` or
`::ffff:127.0.0.1`. Invalid address text is never normalized into a trusted
identity. Ordinary IPv6 peers remain IPv6 identities.

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

## Availability and isolation boundary

Failing to recognize an IPv4-mapped spelling is not a useful fail-closed state.
It makes a legitimate trusted proxy look like an ordinary client, causing every
request behind that proxy to share the proxy-peer limiter bucket while the
forwarded client identity is ignored. One noisy tenant/client can then consume
another legitimate client's capacity. Canonicalizing the mapped peer before the
trust decision preserves the security prerequisite—only an explicitly trusted
transport peer unlocks forwarding evidence—while restoring per-client isolation
for dual-stack Node deployments.

The mapping is intentionally narrow: only syntactically valid dotted
IPv4-mapped IPv6 values are collapsed to IPv4. This is the representation
observed from Node's dual-stack socket boundary and covered by the executable
regression; this repair does not broaden trust to arbitrary hostname, subnet, or
string aliases.

## Acceptance trace

`tests/api/ratelimit.test.mjs` exercises the boundary:

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
   transport peer; and
8. a Node peer represented as `::ffff:127.0.0.1` matches an operator trust
   configuration containing only `127.0.0.1`, so two forwarded clients retain
   separate limiter buckets.

The original bypass RED evidence was the hosted Server Tests failure at
contributor head `c4a3b2f6429634c4165f7efdc71734384241e574`: the spoofed
forwarding value returned `200` where the regression required `429`.

The cross-client poisoning RED evidence was Server Tests run `32614096313` on
the merge result containing contributor head
`dc2fe13b1825975bc38459862f48e2c645351924`: a legitimate victim request
returned `429` where the regression required `200`.

The IPv4-mapped proxy RED is registered at contributor head
`19da67325feeb8275e730c420cb3b7782db3945e`. Server Tests run
`32629696310`, `unit-and-api` job `97170457703`, failed at the intended
regression because a second forwarded client received HTTP `429` instead of
`200` when the socket peer was `::ffff:127.0.0.1` but the trusted-proxy
configuration contained only `127.0.0.1`. Production repair
`dec4e7a2e78c95491576bb35cb3818e5340a63c9` canonicalizes the mapped peer and
forwarded-hop representations at the trust/key boundary. Fresh terminal evidence
for the final documentation head remains revision-specific and must not be
borrowed from predecessor or synthetic-only runs.

## References (APA 7)

Hono. (n.d.). *Node.js*. https://hono.dev/docs/getting-started/nodejs

MDN Web Docs. (2025, July 4). *X-Forwarded-For header*. Mozilla. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For

Petersson, A., & Nilsson, M. (2014). *Forwarded HTTP extension* (RFC 7239). Internet Engineering Task Force. https://doi.org/10.17487/RFC7239
