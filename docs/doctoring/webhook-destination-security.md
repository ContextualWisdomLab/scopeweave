# Webhook destination security — active PR trace

> **Lifecycle:** active-PR evidence only. This document describes the repair lane in PR #588 and must not be read as protected-`develop` shipment or certification evidence until that PR is integrated from an exact gated head.

## Buyer and operator outcome

ScopeWeave accepts buyer-configured webhook destinations, so the outbound HTTP client is an SSRF trust boundary. The active repair makes registration and delivery use one destination policy instead of validating a URL once and later allowing the platform resolver/network stack to choose a different address.

Production webhook destinations are limited to canonical public HTTPS URLs. Immediately before each delivery attempt, ScopeWeave resolves all returned A/AAAA candidates, rejects the entire result if any candidate is malformed or special-use/non-public, and pins the connection to a validated address while preserving the original HTTPS hostname for TLS authority. Redirects are not followed. This closes the validation-versus-connect gap used by DNS-rebinding/pinning attacks and avoids redirect-based policy escape.

Historical ScopeWeave releases accepted arbitrary HTTP(S) webhook URLs, including HTTP endpoints and HTTPS local/private literals that the current registration policy rejects. Leaving those rows active after tightening the transport would make an existing customer integration fail silently on every delivery and retry. The active repair therefore performs a transactional, idempotent startup state migration: every active stored destination is checked against the current synchronous registration policy, policy-incompatible rows are disabled, and one tenant-visible `webhook.security_block` audit event tells the operator to `register_public_https_replacement`. The fixed non-secret audit metadata uses `reason: "destination_policy"`; the migration never reads or copies the signing secret. Public HTTPS rows and already inactive rows remain unchanged.

The migration deliberately performs no DNS/network I/O at startup. A syntactically admissible public hostname that later resolves to a private or special-use address remains subject to the delivery-time A/AAAA authorization boundary and fails closed there. This avoids making database startup availability depend on external DNS while preserving per-attempt rebinding protection.

`SCOPEWEAVE_DEV=1` is an explicit non-production exception. It may admit only HTTP `localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1` destinations. Registration, delivery, and legacy-row migration reuse that same policy: a stored development loopback HTTP webhook remains active, while public HTTP and HTTPS-local/private destinations are disabled. `localhost` DNS answers must all be loopback addresses before any connector is called. The exception does not admit arbitrary RFC 1918, link-local, metadata-service, `.local`, `.localhost` subdomain, or other special-use destinations.

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
| Development loopback | Registration, delivery, and startup migration share the same explicit `SCOPEWEAVE_DEV=1` loopback exception; `localhost` must resolve exclusively to loopback | `tests/unit/webhook-development-transport.test.mjs`, `tests/unit/webhook-legacy-migration.test.mjs`, API smoke test |
| Legacy destination state | Every active historical row is checked against the current synchronous registration policy; HTTP, local-name, and private/special-use literal destinations are disabled atomically; public HTTPS and already inactive rows are preserved | `tests/api/webhook-legacy-migration.test.mjs`, `tests/unit/webhook-legacy-migration.test.mjs` |
| DNS-backed legacy hostname | Startup does not resolve external names; delivery still resolves afresh and rejects any non-public A/AAAA result | migration docstring plus transport unit tests |
| Migration failure | Mutation and audit persistence share one `BEGIN IMMEDIATE` transaction; failure to write durable audit evidence rolls the row mutation back | `tests/unit/webhook-legacy-migration.test.mjs` |
| Secret handling | Migration queries only webhook id, tenant id, URL, and active state; audit metadata is fixed non-secret remediation data | migration unit/API regressions |
| Error disclosure | Destination-policy and transport failures expose stable non-secret errors rather than resolver/socket details | destination-policy and transport tests |

## Standards and primary-source rationale

OWASP identifies custom webhooks as a direct SSRF use case and recommends resolving all A/AAAA results, applying the same IP policy to every result, and disabling redirect following for outbound requests. The ScopeWeave boundary implements those deterministic controls rather than delegating the decision to model judgment.

IANA's live IPv4 and IPv6 Special-Purpose Address Registries are the source of truth for ranges that have special semantics and are not ordinary globally reachable destinations. RFC 6890 defines those registries; RFC 8190 updates their registry metadata model. The code uses explicit denied ranges so addresses such as loopback, private-use, link-local, documentation, multicast, IPv4-mapped IPv6, and other special-purpose space cannot become production webhook targets.

RFC 6761 defines `localhost.` names as special-use and states that address queries for localhost names are expected to yield loopback addresses. ScopeWeave therefore treats bare `localhost` as a development-only spelling and still validates its actual resolver answers as loopback before connection. Literal `127.0.0.0/8` and `::1` follow their IANA/RFC loopback semantics.

Node.js `https.request()` accepts the HTTP request options plus TLS options including `servername`; the active transport uses an injected `lookup` function to pin the validated address while retaining the URL hostname as TLS authority. `agent: false` prevents connection pooling from silently reusing a socket whose address was authorized under a prior resolution.

The legacy-row transition is a product compatibility control rather than a new network policy: once the production registration/transport boundary legitimately refuses a stored destination, continuing to mark that destination active would create misleading operability state. The migration therefore makes persisted state match the enforceable synchronous registration policy and records the customer next action in the existing tenant audit trail.

## TDD and current verification trace

The review finding that exposed registration/delivery drift is preserved by `tests/unit/webhook-development-transport.test.mjs`. On contributor head `dd1893ea870bec9ddbd03fbe2c24f084641f72de`, hosted Server Tests run `32626294458` failed at the new development-loopback delivery assertion with `WebhookDestinationError`; that is the realistic RED reproduction. The root-cause transport repair then made explicit development loopback registration and delivery use the same policy.

A later review identified the legacy-state compatibility problem. The first migration repaired active HTTP rows, but exact-current review of contributor `c7f299a480dc89873fc08807f460c7d248134a83` found that historical HTTPS-local/private rows such as `https://localhost`, `https://127.0.0.1`, and `https://10.0.0.x` would remain active even though the current policy rejects them. The same head's Server Tests run `32627872784` also exposed a separate test-harness defect: Node 22.13 SQLite row objects have a null prototype, so strict deep equality against plain object literals failed before the migration assertions could provide reliable evidence.

The regression-first successor `da062b9b9b82f84ae805a5ed31365e15e63d43a5` normalizes SQLite result rows only at the assertion boundary and adds explicit legacy HTTPS-local/private cases plus correct operator audit semantics. The root-cause implementation `7dbc5a8a1d43ebe6de6326d017af5b210cda25e9` changes the startup migration from an HTTP-prefix query to evaluating every active row with the same synchronous current registration validator; it preserves admitted development loopback destinations, never performs startup DNS, and records `reason: "destination_policy"`. The realistic on-disk API regression was then aligned at `584d7b0527f93165b5b6a97f12eaf6dfcf7a96d0`, including both an active legacy HTTP row and an active private-HTTPS row, public-HTTPS preservation, durable audit evidence, secret non-disclosure, and restart idempotence.

The workflows associated with these rapidly advancing repair heads are revision-sensitive and must not be transferred between heads. The latest exact contributor head after this documentation commit must obtain fresh terminal evidence before any finding is considered closed. Hosted results on this PR remain **behavioral regression evidence, not merge authority** until the exact unchanged contributor head has been regenerated under corrected checkout controls. The repository's protected Server Tests control remains owned by #523, and centrally reusable SAST/Security exact-head repair remains owned by `ContextualWisdomLab/.github#1222`.

## Rollback and residual risk

The startup transition adds no schema object, but it is a real persisted-data state migration: rows rejected by the current synchronous registration policy become inactive. The mutation and its audit evidence are committed together or rolled back together. Re-running startup is idempotent.

Reverting the code does not safely reactivate migrated rows and must not be used as an implicit downgrade path. An operator who needs to restore delivery should register a new public-HTTPS webhook through the normal authenticated API. Reactivating an old policy-incompatible destination would require an explicit security exception and is outside the supported production recovery path. The existing audit record remains durable evidence of why the row was disabled and what action the tenant should take.

Residual limits are intentional and visible: this is an outbound destination authorization layer, not a general egress firewall. Production environments should still apply network egress controls and metadata-service protections as defense in depth. A public service that intentionally redirects or resolves through special-purpose/private addresses is incompatible with the production webhook policy and must expose a stable public HTTPS endpoint instead of requesting an allowlist bypass.

## References (APA 7)

Cheshire, S., & Krochmal, M. (2013). *Special-use domain names* (RFC 6761). Internet Engineering Task Force. https://doi.org/10.17487/RFC6761

Cotton, M., Vegoda, L., Bonica, R., & Haberman, B. (2013). *Special-purpose IP address registries* (RFC 6890). Internet Engineering Task Force. https://doi.org/10.17487/RFC6890

Internet Assigned Numbers Authority. (2025, October 9). *IPv6 special-purpose address space*. https://www.iana.org/assignments/iana-ipv6-special-registry/

Internet Assigned Numbers Authority. (n.d.). *IPv4 special-purpose address space*. Retrieved August 23, 2026, from https://www.iana.org/assignments/iana-ipv4-special-registry/

Node.js contributors. (2025). *HTTPS: Node.js v22 documentation*. Node.js. https://nodejs.org/docs/v22.13.0/api/https.html

OWASP Foundation. (n.d.). *Server side request forgery prevention cheat sheet*. Retrieved August 23, 2026, from https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
