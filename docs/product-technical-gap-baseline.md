# ScopeWeave product–technical gap baseline

This file is the repository-facing snapshot of commercial product gaps that must stay aligned with executable contracts. It is not a release certificate. Live PR head, protected-base, checks, reviews, and release state must be re-read from GitHub rather than copied here as durable authority.

## Product boundary

ScopeWeave owns schedule-control truth for WBS planning, progress, EVM/S-curve, CPM, baselines/history, and the SaaS collaboration layer described by the repository README. In cloud mode it also owns the workspace-scoped webhook subscription and delivery record. It does not own general outbound-network policy for the ContextualWisdomLab ecosystem.

Relevant bounded contexts for the current security slice are:

- **Schedule Control** — Project/WBS/Baseline domain truth and project mutation invariants.
- **Workspace Collaboration** — tenant membership, RBAC, project collaboration, and audit scope.
- **Webhook Delivery** — workspace-scoped subscription, HMAC signing, retry, and delivery evidence.
- **Outbound Network ACL** — an anti-corruption boundary at the transport seam. ScopeWeave must either enforce the webhook-specific destination invariant locally or consume an immutable released EgressWeave contract; it must not copy a mutable sibling implementation or query sibling storage.

The Project aggregate must not become transactionally coupled to outbound delivery. A webhook destination rejection or transport failure records/omits delivery according to the existing webhook contract and does not roll back the triggering Project mutation.

## Current executable state and remaining gap

The active webhook-hardening lineage now establishes these source/test facts:

- registration requires HTTPS, rejects embedded credentials and special-use literal destinations, and delivery revalidates the persisted URL;
- `server/webhook_destination.mjs` owns the shared URL/address admission and injected DNS lookup boundary;
- the webhook-only Undici `Agent` consumes that lookup, so all A/AAAA answers are checked before one admitted address is returned directly to the socket lookup;
- webhook delivery uses a per-request dispatcher with `redirect: 'error'`; unrelated OIDC/global Fetch traffic is not routed through the webhook policy;
- `tests/api/webhook-ssrf.test.mjs` exercises the exported isolated webhook agent directly instead of monkeypatching every Undici Agent, and covers special-use literals, mixed DNS answers, exact selected-address return, persisted invalid destination rejection, a real 302 carrying a private `Location`, delivery receipts, and one retry;
- the address policy rejects deprecated IPv4-compatible IPv6 `::/96`, IPv4-mapped `::ffff:0:0/96`, and the RFC 8215 local-use translation prefix `64:ff9b:1::/48`;
- RFC 6052 `64:ff9b::/96` is evaluated by its embedded IPv4 destination rather than blanket-denied. Public embedded destinations remain admissible; private, loopback, documentation, benchmark, multicast, and otherwise non-public embedded destinations fail closed;
- `server/webhook_destination.mjs` is explicitly inside the owned c8 instrumentation denominator.

The source-level P0 boundary is implemented on the active branch, but it is not a release GREEN. Hosted correctness/coverage/security/static-analysis checks and independent current-head review remain required on one unchanged exact head. PR #649 remains a divergent evidence lane and must not be closed as a duplicate until a successor is verified to inherit every valid NAT64/address/transport/application-retry fixture and documentation delta. Normal descendants that improve test isolation are adopted; descendants that regress standards-correct address semantics or owned coverage are repaired without rewriting history.

## Security invariant and acceptance

For each webhook delivery:

1. Parse the persisted destination and require HTTPS with no embedded userinfo.
2. Resolve the original hostname once for the transport attempt and obtain all A/AAAA answers.
3. Fail closed if any resolved address is outside the repository's admitted public-address policy. The policy must stay aligned with IANA and applicable standards: `64:ff9b::/96` is globally reachable but RFC 6052 forbids using it for non-global embedded IPv4 destinations, while `64:ff9b:1::/48` is local-use and not globally reachable.
4. Select an admitted address deterministically and bind that exact address to the socket connection while preserving the original hostname for HTTP Host and TLS/SNI verification.
5. Do not follow HTTP redirects implicitly. A deterministic local 3xx fixture must prove that a `Location` header cannot create a second unvalidated hop.
6. Preserve request body, HMAC signature, timeout/cancellation, retry, tenant scope, and delivery-record semantics.
7. Keep webhook transport policy local to this request path; do not install a process-global dispatcher to make a leaf test pass.
8. Carry negative controls for special-use/translated private destinations and positive controls for representative globally routable IPv4/IPv6 destinations so hardening cannot silently become an allow-nothing policy.
9. Keep the outbound-policy module inside owned production coverage and retain deterministic edge cases for each translation/address family used as security authority.

A GREEN requires the focused SSRF/API regression, supported Node install/test/coverage path, Security/SAST/CodeQL gates, and an independent current-head review. Local source inspection or predecessor GREEN is not a substitute for that exact-head evidence.

## DDD / data / operability implications

`Webhook` subscription identity and delivery evidence remain workspace-scoped. Destination validation is a domain service / ACL at the outbound boundary, not a property of the Project aggregate and not cross-service SQL. Delivery attempts must remain idempotent with respect to the existing retry identity and must not silently turn security rejection into successful delivery evidence.

The current development database uses `node:sqlite`; production database substitution must preserve tenant/RBAC/webhook invariants and migration behavior. This gap does not authorize database denormalization, cross-tenant indexes without evidence, or a mutable sibling dependency.

Operational evidence for release must include timeout/cancellation cleanup and connection lifecycle closure in addition to HTTP status. If a future external EgressWeave release replaces the local ACL, ScopeWeave must pin an immutable released version and retain consumer contract tests for the same destination/DNS/connection/redirect invariants.

## Buyer-visible gap order

P0 is exact-head verification and consolidation of the implemented connection-time SSRF authority without losing valid #649 evidence. P1 is immutable delivery evidence that distinguishes destination-policy rejection, DNS-resolution rejection, redirect rejection, timeout/cancellation, transport failure, and remote HTTP failure without leaking secrets. P2 is a realistic, right-cleared SaaS rehearsal covering webhook creation, project mutation, signed delivery, one retry, delivery log inspection, secret rotation, and failure recovery under the supported deployment stack.

No buyer-facing p95 ≤20 ms statement is made for webhook delivery: the operation is external-I/O bound and must preserve security/timeout correctness. Applicable buyer page/API performance claims still require measured k6/E2E evidence on the actual interactive request path rather than sample reduction or unrealistic cache warm-up.

## Traceability

Repository evidence for this snapshot is the active webhook-hardening PR and its executable test/module lineage. The documentation deliberately avoids freezing a self-referential current-head SHA; use live GitHub PR/check APIs when collecting exact-head evidence.

Primary references:

- Internet Assigned Numbers Authority. (2025). *IPv6 special-purpose address space*. IANA. `64:ff9b::/96` is marked globally reachable; `64:ff9b:1::/48` is not. https://www.iana.org/assignments/iana-ipv6-special-registry
- Bao, C., Huitema, C., Bagnulo, M., Boucadair, M., & Li, X. (2010). *RFC 6052: IPv6 addressing of IPv4/IPv6 translators*. Internet Engineering Task Force. The Well-Known Prefix is `64:ff9b::/96`, with the IPv4 destination in the low-order 32 bits; the WKP must not represent non-global IPv4 destinations. https://www.rfc-editor.org/rfc/rfc6052
- Anderson, T. (2017). *RFC 8215: Local-use IPv4/IPv6 translation prefix*. Internet Engineering Task Force. `64:ff9b:1::/48` is reserved for local use and is not globally reachable. https://www.rfc-editor.org/rfc/rfc8215
- Hinden, R., & Deering, S. (2006). *RFC 4291: IP Version 6 Addressing Architecture*. Internet Engineering Task Force. IPv4-Compatible IPv6 addresses are deprecated. https://www.rfc-editor.org/rfc/rfc4291
- Blanchet, M. (2008). *RFC 5156: Special-Use IPv6 Addresses*. Internet Engineering Task Force. IPv4-compatible and IPv4-mapped forms are not public-Internet destination authority. https://www.rfc-editor.org/rfc/rfc5156
- WHATWG. (2026). *Fetch Standard*. Redirect mode is explicitly `follow`, `error`, or `manual`; outbound code that does not support redirects must select a non-follow mode. https://fetch.spec.whatwg.org/

## Release gate

A source fix is not a release. Promotion requires normal protected-branch integration plus current version/CHANGELOG, immutable tag/package or deployment artifact as applicable, SBOM, provenance, reproducibility evidence, rollback/recovery procedure, and the repository/organization-required review and security gates on the exact protected generation. This document must be revisited when those facts change.
