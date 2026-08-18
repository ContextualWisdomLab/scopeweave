# Outbound webhook SSRF boundary: evidence and design record

## Status boundary

As of this active repair, protected `develop@1fadec04195805722829b386475a09a15f8cd926`
still contains the historical webhook implementation that accepts arbitrary
`http(s)` destinations and later supplies the persisted URL to server-side
`fetch()`. That is protected-shipped truth until this pull request is integrated.

The active `fix/webhook-ssrf-551` pull request introduces the candidate repair
described below. Nothing in this record represents a certification claim or a
statement that protected `develop` already contains the repair.

## Buyer-visible risk

A custom webhook is intentionally an outbound server-side request whose target
is supplied by a tenant administrator. Without a destination authority boundary,
that feature can become an SSRF primitive against the ScopeWeave runtime,
neighboring private services, link-local cloud metadata endpoints, or other
addresses that are not Internet-facing webhook authorities. Redirect following
and DNS rebinding can invalidate an otherwise correct one-time URL or DNS check.

The commercial requirement is therefore stronger than syntactic URL validation:
ScopeWeave must prove that the address used by the actual socket is an allowed
public destination immediately before every attempt.

## Candidate design

The active repair applies the following fail-closed contract:

1. webhook registration is parsed with the WHATWG `URL` implementation and
   production accepts HTTPS only; URL credentials, fragments, localhost-like
   names, and literal denied addresses are rejected;
2. every delivery attempt performs a fresh A/AAAA lookup and accepts the attempt
   only when **every** returned address passes the same public-address policy;
3. private, loopback, link-local, shared, unspecified, mapped, multicast,
   documentation, benchmark, reserved, ULA, and other non-public/special-use
   ranges are rejected conservatively using the current IANA special-purpose
   registries plus multicast boundaries;
4. the HTTPS socket receives a custom `lookup` callback containing the
   just-validated address, while the original DNS hostname remains the HTTP/TLS
   authority and SNI name. `agent: false` prevents an older pooled connection
   from bypassing the fresh per-attempt authorization;
5. Node's native `https.request()` is used directly; redirects are never
   followed, so a 3xx response is a failed delivery rather than authority
   transplantation of the signed body and HMAC header;
6. the existing three-second abort budget and bounded retry behavior remain in
   the application core. Each retry re-enters the transport and therefore
   resolves, validates, and pins again;
7. policy, resolver, TLS, and transport failures expose stable non-secret error
   classes rather than internal addresses or resolver/socket details; and
8. the legacy development-only loopback HTTP registration fixture remains
   isolated behind `SCOPEWEAVE_DEV=1` solely so the existing failure/retry smoke
   path remains deterministic. The outbound transport itself still rejects HTTP,
   so that fixture cannot make a loopback connection and production never
   inherits it.

The existing Hono route graph is temporarily retained in `server/app_core.mjs`.
`server/app.mjs` is the sole exported server facade and interposes the registration
policy plus the signed-webhook egress transport while delegating unrelated OIDC,
Clearfolio, billing, tenant, and authentication fetches to native `fetch`. This
keeps the security slice bounded and reviewable rather than rewriting unrelated
application behavior inside the same repair.

## Verification contract

Deterministic regression evidence must cover at least:

- production registration rejection for plaintext HTTP, localhost and
  `.localhost`, IPv4 loopback in dotted/decimal/hex forms, RFC 1918, IPv4
  link-local/metadata-style destinations, IPv6 loopback, ULA, IPv4-mapped IPv6,
  URL credentials, and fragments;
- direct public IPv4 and IPv6 literals plus a public-hostname-shaped success seam
  without depending on the Internet;
- empty/malformed/private DNS responses and mixed public+private answer sets,
  with zero connector calls after a denied resolution;
- a DNS-rebinding sequence where a first public answer can be used but a later
  private answer is rejected before the retry socket is created;
- the custom connector lookup returning only the address validated for that
  attempt while preserving the original hostname as TLS `servername`;
- redirects treated as failures without a second request;
- stable error text for resolver, synchronous request, asynchronous socket, and
  pre-aborted-signal failures; and
- canonical `test:unit`, `test:api`, and c8 registration for every new production
  module, while continuing to measure the moved application core rather than
  creating a false coverage improvement through a filename split.

A green successor head does not erase the deliberately preserved RED predecessor:
`006cfabda2f9e1b36221215a481b9475a07164c4` registered the real production API
regression and the hosted `unit-and-api` lane failed because protected behavior
returned HTTP 200 for the first denied plaintext-HTTP destination. Exact-current-
head gates must be regenerated after every production or evidence change.

## Standards and primary-source rationale

OWASP identifies custom webhooks as an SSRF use case, recommends validating both
A and AAAA answers when arbitrary external targets are allowed, calls out DNS
pinning/rebinding, and recommends disabling redirects. ScopeWeave therefore does
not rely on registration-time DNS or a second independent resolver decision at
connection time.

IANA's IPv4 and IPv6 Special-Purpose Address Registries are the authoritative
machine-readable inventory for address blocks whose routing or protocol semantics
are exceptional. The registries were last updated October 9, 2025 when this
record was prepared. ScopeWeave uses a conservative deny policy for ranges not
suitable as ordinary public webhook authorities; this includes the IPv6 dummy
prefix `100:0:0:1::/64` added to the registry in 2025.

RFC 6890 establishes the special-purpose address registries and their
`Globally Reachable` semantics. RFC 4291 defines IPv6 unspecified, loopback,
IPv4-mapped, link-local, and multicast semantics. RFC 1918, RFC 3927, and RFC
4193 define private IPv4, IPv4 link-local, and IPv6 unique-local space,
respectively.

Node.js 22 documents that `https.request()` accepts HTTP request options plus TLS
options such as `servername`; its underlying connection options support a custom
DNS `lookup` function. The active repair uses that supported seam so address
validation and socket selection are one authorization decision while TLS still
authenticates the original webhook hostname.

## References

Cotton, M., Vegoda, L., Bonica, R., & Haberman, B. (2013). *Special-purpose IP
address registries* (BCP 153; RFC 6890). Internet Engineering Task Force.
https://doi.org/10.17487/RFC6890

Cheshire, S., Aboba, B., & Guttman, E. (2005). *Dynamic configuration of IPv4
link-local addresses* (RFC 3927). Internet Engineering Task Force.
https://doi.org/10.17487/RFC3927

Hinden, R., & Deering, S. (2006). *IP version 6 addressing architecture* (RFC
4291). Internet Engineering Task Force. https://doi.org/10.17487/RFC4291

Hinden, R., & Haberman, B. (2005). *Unique local IPv6 unicast addresses* (RFC
4193). Internet Engineering Task Force. https://doi.org/10.17487/RFC4193

Internet Assigned Numbers Authority. (2025, October 9). *IPv4 special-purpose
address space*. https://www.iana.org/assignments/iana-ipv4-special-registry/

Internet Assigned Numbers Authority. (2025, October 9). *IPv6 special-purpose
address space*. https://www.iana.org/assignments/iana-ipv6-special-registry/

Open Worldwide Application Security Project Foundation. (n.d.). *Server side
request forgery prevention cheat sheet*. OWASP Cheat Sheet Series. Retrieved
August 18, 2026, from
https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

OpenJS Foundation. (2026). *HTTPS*. Node.js v22 documentation.
https://nodejs.org/docs/latest-v22.x/api/https.html

Rekhter, Y., Moskowitz, B., Karrenberg, D., de Groot, G. J., & Lear, E. (1996).
*Address allocation for private Internets* (BCP 5; RFC 1918). Internet
Engineering Task Force. https://doi.org/10.17487/RFC1918
