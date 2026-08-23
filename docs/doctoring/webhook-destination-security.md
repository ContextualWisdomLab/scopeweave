# Webhook destination security — active PR trace

> **Lifecycle:** active-PR evidence only. This document describes the repair lane in PR #588 and must not be read as protected-`develop` shipment or certification evidence until that PR is integrated from an exact gated head.

## Buyer and operator outcome

ScopeWeave accepts buyer-configured webhook destinations, so the outbound HTTP client is an SSRF trust boundary. The active repair makes registration and delivery use one destination policy instead of validating a URL once and later allowing the platform resolver/network stack to choose a different address.

Production webhook destinations are limited to canonical public HTTPS URLs. Immediately before each delivery attempt, ScopeWeave resolves all returned A/AAAA candidates, rejects the entire result if any candidate is malformed or special-use/non-public, and pins the connection to a validated address while preserving the original HTTPS hostname for TLS authority. Redirects are not followed. This closes the common validation-versus-connect gap used by DNS-rebinding/pinning attacks and avoids redirect-based policy escape.

Historical ScopeWeave releases accepted `http://` webhook destinations. Leaving those rows active after tightening the transport would make an existing customer integration fail silently on every delivery and retry. The active repair therefore performs a transactional, idempotent startup state migration: previously active HTTP destinations that the current production policy cannot deliver are disabled, and one tenant-visible `webhook.security_block` audit event tells the operator to `register_public_https_replacement`. The audit record never reads or copies the signing secret. HTTPS rows and already inactive rows are left unchanged.

`SCOPEWEAVE_DEV=1` is an explicit non-production exception. It may admit only HTTP `localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1` destinations. Registration, delivery, and legacy-row migration reuse that same policy: a stored development loopback HTTP webhook remains active, while arbitrary HTTP destinations are still disabled. `localhost` DNS answers must all be loopback addresses before any connector is called. The exception does not admit arbitrary RFC 1918, link-local, metadata-service, `.local`, `.localhost` subdomain, or other special-use destinations.

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
| Legacy HTTP state | Active historical HTTP rows are disabled atomically before serving; HTTPS and already inactive rows are preserved; one idempotent audit event gives the replacement action | `tests/api/webhook-legacy-migration.test.mjs`, `tests/unit/webhook-legacy-migration.test.mjs` |
| Migration failure | Mutation and audit persistence share one `BEGIN IMMEDIATE` transaction; failure to write durable audit evidence rolls the row mutation back | `tests/unit/webhook-legacy-migration.test.mjs` |
| Secret handling | Migration queries only webhook id, tenant id, URL, and active state; audit metadata is fixed non-secret remediation data | migration unit/API regressions |
| Error disclosure | Destination-policy and transport failures expose stable non-secret errors rather than resolver/socket details | destination-policy and transport tests |

## Standards and primary-source rationale

OWASP identifies custom webhooks as a direct SSRF use case and recommends resolving all A/AAAA results, applying the same IP policy to every result, and disabling redirect following for outbound requests. The ScopeWeave boundary implements those deterministic controls rather than delegating the decision to model judgment.

IANA's live IPv4 and IPv6 Special-Purpose Address Registries are the source of truth for ranges that have special semantics and are not ordinary globally reachable destinations. RFC 6890 defines those registries; RFC 8190 updates their registry metadata model. The code uses explicit denied ranges so addresses such as loopback, private-use, link-local, documentation, multicast, IPv4-mapped IPv6, and other special-purpose space cannot become production webhook targets.

RFC 6761 defines `localhost.` names as special-use and states that address queries for localhost names are expected to yield loopback addresses. ScopeWeave therefore treats bare `localhost` as a development-only spelling and still validates its actual resolver answers as loopback before connection. Literal `127.0.0.0/8` and `::1` follow their IANA/RFC loopback semantics.

Node.js `https.request()` accepts the HTTP request options plus TLS options including `servername`; the active transport uses an injected `lookup` function to pin the validated address while retaining the URL hostname as TLS authority. `agent: false` prevents connection pooling from silently reusing a socket whose address was authorized under a prior resolution.

The legacy-row transition is a product compatibility control rather than a new network policy: once the production transport legitimately refuses HTTP, continuing to mark an impossible destination active would create misleading operability state. The migration therefore makes the persisted state match the enforceable transport policy and records the customer next action in the existing tenant audit trail.

## TDD and current verification trace

The review finding that exposed registration/delivery drift is preserved by `tests/unit/webhook-development-transport.test.mjs`. On contributor head `dd1893ea870bec9ddbd03fbe2c24f084641f72de`, hosted Server Tests run `32626294458` failed at the new development-loopback delivery assertion with `WebhookDestinationError`; that is the realistic RED reproduction.

The root-cause repair is carried by `server/webhook_transport.mjs` plus the narrow registration facade in `server/app.mjs`: one validator now defines both registration and delivery admission. On contributor head `ed44d32289241f9f73e99e8119001e4e187d93be`, Server Tests run `32626453099` passed both `unit-and-api` and `cloud-e2e`; its log explicitly includes `webhook development loopback transport tests passed` and `API smoke tests passed`. Fuzz, Dependency Review, OSV Scanner, Security Scan, and SAST Semgrep also reported terminal success for that contributor revision at the workflow level.

A later current-source review found a separate compatibility defect: pre-existing HTTP rows accepted by historical releases would remain active even though the new production transport could never deliver them. The realistic database regression was committed first at `b65fa41d30a024f6a37466344c73f701c1d0bf81` and registered in the canonical API lane at `0e28697724c3671cdb5569324962d12b4cf6db05`. That exact source had no startup migration, so its seeded active legacy HTTP row necessarily remained active. Hosted Server Tests for that transient RED revision were cancelled after the repair branch advanced; they are not claimed as RED evidence.

The smallest root-cause repair introduces `server/webhook_legacy_migration.mjs` and invokes it from `server/db.mjs` after schema initialization. The migration uses the same current destination-policy validator for the development exception, selects no signing secret, changes only active historical HTTP rows, records one fixed tenant audit remediation event, and is atomic and idempotent. `tests/unit/webhook-legacy-migration.test.mjs` additionally proves production behavior, development-loopback preservation, restart idempotence, and transaction rollback when audit persistence fails. `tests/api/webhook-legacy-migration.test.mjs` exercises the real startup import against a legacy on-disk SQLite schema. Both regressions are part of the canonical unit/API and coverage commands.

Hosted results for this PR remain **behavioral regression evidence, not merge authority**, until the exact unchanged contributor head has been regenerated under corrected checkout controls. The repository's current PR Server Tests workflow still materializes GitHub's synthetic merge result rather than the contributor head. The repo-owned exact-head workflow repair remains tracked in #523, and centrally reusable SAST/Security exact-head repair remains owned by `ContextualWisdomLab/.github#1222`. Integration still requires fresh exact-head evidence and a qualifying independent current-head approval under live branch protection/rulesets.

## Rollback and residual risk

The startup transition adds no schema object, but it is a real persisted-data state migration: rows that could no longer be delivered under production policy become inactive. The mutation and its audit evidence are committed together or rolled back together. Re-running startup is idempotent.

Reverting the code does not safely reactivate migrated rows and must not be used as an implicit downgrade path. An operator who needs to restore delivery should register a new public-HTTPS webhook through the normal authenticated API. Reactivating an old HTTP destination would require an explicit security exception and is outside the supported production recovery path. The existing audit record remains durable evidence of why the row was disabled and what action the tenant should take.

Residual limits are intentional and visible: this is an outbound destination authorization layer, not a general egress firewall. Production environments should still apply network egress controls and metadata-service protections as defense in depth. A public service that intentionally redirects or resolves through special-purpose/private addresses is incompatible with the production webhook policy and must expose a stable public HTTPS endpoint instead of requesting an allowlist bypass.

## References (APA 7)

Cheshire, S., & Krochmal, M. (2013). *Special-use domain names* (RFC 6761). Internet Engineering Task Force. https://doi.org/10.17487/RFC6761

Cotton, M., Vegoda, L., Bonica, R., & Haberman, B. (2013). *Special-purpose IP address registries* (RFC 6890). Internet Engineering Task Force. https://doi.org/10.17487/RFC6890

Internet Assigned Numbers Authority. (2025, October 9). *IPv6 special-purpose address space*. https://www.iana.org/assignments/iana-ipv6-special-registry/

Internet Assigned Numbers Authority. (n.d.). *IPv4 special-purpose address space*. Retrieved August 23, 2026, from https://www.iana.org/assignments/iana-ipv4-special-registry/

Node.js contributors. (2025). *HTTPS: Node.js v22 documentation*. Node.js. https://nodejs.org/docs/v22.13.0/api/https.html

OWASP Foundation. (n.d.). *Server side request forgery prevention cheat sheet*. Retrieved August 23, 2026, from https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html