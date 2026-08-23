# Webhook destination security — active PR trace

> **Lifecycle:** active-PR evidence only. This document describes the repair lane in PR #588 and must not be read as protected-`develop` shipment or certification evidence until that PR is integrated from an exact gated head.

## Buyer and operator outcome

ScopeWeave accepts buyer-configured webhook destinations, so the outbound HTTP client is an SSRF trust boundary. The active repair makes registration and delivery use one destination policy instead of validating a URL once and later allowing the platform resolver/network stack to choose a different address.

Production webhook destinations are limited to canonical public HTTPS URLs. Immediately before each delivery attempt, ScopeWeave resolves all returned A/AAAA candidates, rejects the entire result if any candidate is malformed or special-use/non-public, and pins the connection to a validated address while preserving the original HTTPS hostname for TLS authority. Redirects are not followed. This closes the common validation-versus-connect gap used by DNS-rebinding/pinning attacks and avoids redirect-based policy escape.

`SCOPEWEAVE_DEV=1` is an explicit non-production exception. It may admit only HTTP `localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1` destinations. Delivery reuses that same transport policy; `localhost` DNS answers must all be loopback addresses before any connector is called. The exception does not admit arbitrary RFC 1918, link-local, metadata-service, `.local`, `.localhost` subdomain, or other special-use destinations.

## Control design

| Boundary | Active-PR behavior | Acceptance evidence |
| --- | --- | --- |
| URL parsing | WHATWG `URL`; credentials and fragments rejected | `tests/api/webhook-destination-policy.test.mjs`, `tests/unit/webhook-transport.test.mjs` |
| Production scheme | HTTPS only | destination-policy and transport unit tests |
| Special-use IPs | IPv4/IPv6 special-purpose ranges denied; IPv6 public acceptance is limited to the ordinary `2000::/3` global-unicast envelope and excludes registered special-purpose blocks | transport policy tests; IANA registry trace below |
| DNS authorization | Every returned A/AAAA address must pass policy; mixed public/private answers fail closed | transport unit tests |
| DNS rebinding | Resolution occurs per outbound attempt and the socket lookup is pinned to the validated candidate | transport unit tests |
| TLS authority | Original hostname remains TLS `servername` for HTTPS hostnames even while address selection is pinned | transport unit tests |
| Redirects | Transport returns 3xx without following it; delivery is recorded unsuccessful by existing webhook logic | transport/API regression coverage |
| Replay safety | Another validated address may be tried only before a connection becomes established; after connect/TLS secure-connect, the signed body is not replayed within the same attempt | transport unit tests |
| Development loopback | Registration and delivery share the same explicit `SCOPEWEAVE_DEV=1` loopback exception; `localhost` must resolve exclusively to loopback | `tests/unit/webhook-development-transport.test.mjs`, API smoke test |
| Error disclosure | Destination-policy and transport failures expose stable non-secret errors rather than resolver/socket details | destination-policy and transport tests |

## Standards and primary-source rationale

OWASP identifies custom webhooks as a direct SSRF use case and recommends resolving all A/AAAA results, applying the same IP policy to every result, and disabling redirect following for outbound requests. The ScopeWeave boundary implements those deterministic controls rather than delegating the decision to model judgment.

IANA's live IPv4 and IPv6 Special-Purpose Address Registries are the source of truth for ranges that have special semantics and are not ordinary globally reachable destinations. RFC 6890 defines those registries; RFC 8190 updates their registry metadata model. The code uses explicit denied ranges so addresses such as loopback, private-use, link-local, documentation, multicast, IPv4-mapped IPv6, and other special-purpose space cannot become production webhook targets.

RFC 6761 defines `localhost.` names as special-use and states that address queries for localhost names are expected to yield loopback addresses. ScopeWeave therefore treats bare `localhost` as a development-only spelling and still validates its actual resolver answers as loopback before connection. Literal `127.0.0.0/8` and `::1` follow their IANA/RFC loopback semantics.

Node.js `https.request()` accepts the HTTP request options plus TLS options including `servername`; the active transport uses an injected `lookup` function to pin the validated address while retaining the URL hostname as TLS authority. `agent: false` prevents connection pooling from silently reusing a socket whose address was authorized under a prior resolution.

## TDD and current verification trace

The review finding that exposed registration/delivery drift is preserved by `tests/unit/webhook-development-transport.test.mjs`. On contributor head `dd1893ea870bec9ddbd03fbe2c24f084641f72de`, hosted Server Tests run `32626294458` failed at the new development-loopback delivery assertion with `WebhookDestinationError`; that is the realistic RED reproduction.

The root-cause repair is carried by `server/webhook_transport.mjs` plus the narrow registration facade in `server/app.mjs`: one validator now defines both registration and delivery admission. On contributor head `ed44d32289241f9f73e99e8119001e4e187d93be`, Server Tests run `32626453099` passed both `unit-and-api` and `cloud-e2e`; its log explicitly includes `webhook development loopback transport tests passed` and `API smoke tests passed`. Fuzz, Dependency Review, OSV Scanner, Security Scan, and SAST Semgrep also reported terminal success for that contributor revision at the workflow level.

Those hosted results are **behavioral regression evidence, not merge authority**. The repository's current PR Server Tests workflow checks out GitHub's synthetic merge result (`75aa3377b632c9e954c05658e377e8306ac0f5ab` for that run) rather than the unchanged contributor head. The repo-owned exact-head workflow repair remains tracked in #523, and centrally reusable SAST/Security exact-head repair remains owned by `ContextualWisdomLab/.github#1222`. Integration still requires fresh exact-head evidence and a qualifying independent current-head approval under live branch protection/rulesets.

## Rollback and residual risk

Rollback is code-only; this repair adds no database migration. Reverting the transport would re-open the verified registration/delivery consistency defect and should therefore require an explicit security exception rather than an operational shortcut.

Residual limits are intentional and visible: this is an outbound destination authorization layer, not a general egress firewall. Production environments should still apply network egress controls and metadata-service protections as defense in depth. A public service that intentionally redirects or resolves through special-purpose/private addresses is incompatible with the production webhook policy and must expose a stable public HTTPS endpoint instead of requesting an allowlist bypass.

## References (APA 7)

Cheshire, S., & Krochmal, M. (2013). *Special-use domain names* (RFC 6761). Internet Engineering Task Force. https://doi.org/10.17487/RFC6761

Cotton, M., Vegoda, L., Bonica, R., & Haberman, B. (2013). *Special-purpose IP address registries* (RFC 6890). Internet Engineering Task Force. https://doi.org/10.17487/RFC6890

Internet Assigned Numbers Authority. (2025, October 9). *IPv6 special-purpose address space*. https://www.iana.org/assignments/iana-ipv6-special-registry/

Internet Assigned Numbers Authority. (n.d.). *IPv4 special-purpose address space*. Retrieved August 23, 2026, from https://www.iana.org/assignments/iana-ipv4-special-registry/

Node.js contributors. (2025). *HTTPS: Node.js v22 documentation*. Node.js. https://nodejs.org/docs/v22.13.0/api/https.html

OWASP Foundation. (n.d.). *Server side request forgery prevention cheat sheet*. Retrieved August 23, 2026, from https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
