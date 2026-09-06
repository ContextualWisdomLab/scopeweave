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

## Current executable gap

The active webhook-hardening lineage has already established these source/test facts:

- registration admits HTTPS destinations and delivery revalidates the persisted URL;
- `tests/api/webhook-ssrf.test.mjs` specifies literal-address rejection plus deterministic private-only and mixed public/private A/AAAA rejection;
- `server/webhook_destination.mjs` contains the candidate URL/address admission and injected DNS lookup boundary;
- `server/app.mjs` still carries the predecessor inline destination classifier/lookup and therefore does not yet consume that candidate boundary.

The current slice is consequently RED at the application transport integration seam. Do not describe it as an SSRF GREEN until the exact application path consumes the admitted address without a second DNS authority decision and the hosted tests execute on one unchanged head.

## Security invariant and acceptance

For each webhook delivery:

1. Parse the persisted destination and require HTTPS with no embedded userinfo.
2. Resolve the original hostname once for the transport attempt and obtain all A/AAAA answers.
3. Fail closed if any resolved address is outside the repository's admitted public-address policy. The policy must be maintained against IANA special-purpose address registries rather than a handful of string prefixes.
4. Select an admitted address deterministically and bind that exact address to the socket connection while preserving the original hostname for HTTP Host and TLS/SNI verification.
5. Do not follow HTTP redirects implicitly. A deterministic local 3xx fixture must prove that a Location header cannot create a second unvalidated hop.
6. Preserve the existing request body, HMAC signature, timeout/cancellation, retry, tenant scope, and delivery-record semantics.
7. Keep webhook transport policy local to this request path; do not install a process-global dispatcher to make a leaf test pass.

A GREEN requires the focused SSRF/API regression, the supported Node runtime install/test path, security/SAST/CodeQL gates, and an independent current-head review. Public-network success is not acceptance evidence.

## DDD / data / operability implications

`Webhook` subscription identity and delivery evidence remain workspace-scoped. Destination validation is a domain service / ACL at the outbound boundary, not a property of the Project aggregate and not cross-service SQL. Delivery attempts must remain idempotent with respect to the existing retry identity and must not silently turn security rejection into successful delivery evidence.

The current development database uses `node:sqlite`; production database substitution must preserve tenant/RBAC/webhook invariants and migration behavior. This gap does not authorize database denormalization, cross-tenant indexes without evidence, or a mutable sibling dependency.

Operational evidence for release must include timeout/cancellation cleanup and connection lifecycle closure in addition to HTTP status. If a future external EgressWeave release replaces the local ACL, ScopeWeave must pin an immutable released version and retain consumer contract tests for the same destination/redirect invariants.

## Buyer-visible gap order

P0 is the connection-time SSRF authority above. P1 is immutable delivery evidence that distinguishes destination-policy rejection, DNS-resolution rejection, redirect rejection, timeout/cancellation, transport failure, and remote HTTP failure without leaking secrets. P2 is a realistic, right-cleared SaaS rehearsal covering webhook creation, project mutation, signed delivery, one retry, delivery log inspection, secret rotation, and failure recovery under the supported deployment stack.

No buyer-facing p95 ≤20 ms statement is made for webhook delivery: the operation is external-I/O bound and must preserve security/timeout correctness. Applicable buyer page/API performance claims still require measured k6/E2E evidence on the actual interactive request path rather than sample reduction or unrealistic cache warm-up.

## Traceability

Repository evidence for this snapshot is the active webhook-hardening PR and its executable test/module lineage. The documentation deliberately avoids freezing a self-referential current-head SHA; use `git rev-parse HEAD` and the live GitHub PR/check APIs when collecting exact-head evidence.

Primary references:

- Internet Assigned Numbers Authority. (n.d.). *Number-related registries*. IANA. IPv4/IPv6 special-purpose registries are the address-policy authority. https://www.iana.org/numbers/registries
- Internet Assigned Numbers Authority. (2013). *RFC 6890: Special-Purpose IP Address Registries*. https://www.iana.org/news/2013/rfc-6890-special-purpose-ip-address-registries
- WHATWG. (2026). *Fetch Standard*. Redirect mode is explicitly `follow`, `error`, or `manual`; outbound code that does not support redirects must select a non-follow mode. https://fetch.spec.whatwg.org/

## Release gate

A source fix is not a release. Promotion requires normal protected-branch integration plus current version/CHANGELOG, immutable tag/package or deployment artifact as applicable, SBOM, provenance, reproducibility evidence, rollback/recovery procedure, and the repository/organization-required review and security gates on the exact protected generation. This document must be revisited when those facts change.