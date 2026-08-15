# Realtime stream access-grant runtime

Status: **active stacked PR only — not protected-`develop` shipped truth**. This document describes the bounded implementation in PR #513, stacked on PR #512 for issue #413. The parent base observed immediately before this document was `fix/attachment-view-grant-runtime-413@d2edcb55bda0ce980f6d1f3d76e034d5ca1ca307`. Reconcile these statements against the live protected base before integration.

## Customer decision and next action

Customers should continue using ScopeWeave realtime collaboration through the normal web client; they should not copy, bookmark, log, or construct stream credential URLs. Operators evaluating this slice should verify that browser traffic performs an authenticated grant exchange followed by an EventSource request containing only a short-lived opaque `grant`, and that reconnect obtains a different grant. If any broad session JWT appears in an EventSource request URL, access log, browser history entry, or referrer capture, treat that as a security regression and block release.

## Threat and causal defect

The protected application core historically compensates for native `EventSource` lacking arbitrary request headers by constructing `/api/projects/:id/stream?token=<session JWT>`. A bearer credential in a URI can be copied into access logs, browser or intermediary telemetry, screenshots, incident evidence, and other URL-handling systems. RFC 6750 explicitly treats URI-query bearer transport as a method that should not be used unless the alternatives are impossible and calls out security deficiencies; RFC 9700 is the current OAuth 2.0 security Best Current Practice and strengthens the expectation that access tokens are not passed in URI query parameters.

The problem is the credential transport, not realtime collaboration itself. A safe fix therefore must preserve the connected preamble, project update/comment/restore fan-out, direct Authorization-header access for capable API clients, tenant isolation, revocation behavior, observability, and reconnect semantics while eliminating broad browser URL credentials.

## Bounded decision

PR #513 introduces a 60-second, one-time, project-bound `stream` access grant using the grant domain and SQLite persistence supplied by parent PR #512. The browser uses the existing broad session credential only in an `Authorization: Bearer` header on `POST /api/projects/:id/access-grants` with the exact body `{ "purpose": "stream" }`. The response contains an opaque 43-character base64url grant in a same-origin `/api/projects/:id/stream?grant=...` URL.

The public security gateway, `server/app.mjs`, owns the externally reachable stream route in this staged architecture. It rejects the historical `token` query parameter, mixed credentials, duplicate/extra query parameters, malformed grants, wrong-project grants, expired grants, replayed grants, and subjects whose live membership no longer authorizes the project. Direct Authorization-header stream requests remain supported and validate durable session token-version state.

A successful one-time redemption opens an SSE response with `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. Native EventSource automatic reconnect is deliberately suppressed because it would replay an already-consumed grant. The client closes the failed native source, waits for the bounded retry delay, exchanges for a fresh grant, and only then opens a replacement EventSource.

## Staged gateway boundary

`server/app_core.mjs` remains historical core code during this stack and still contains the predecessor query-token stream implementation. That route is **not** the public production boundary when `server/server.mjs` boots the exported application from `server/app.mjs`; the gateway intercepts the exact public stream route before delegating all other requests to the core.

To avoid inventing a synthetic internal credential or bypassing core authorization, the gateway delegates normal project writes to the core and relays successful project-update, revision-restore, and comment response facts into its own secure SSE controller map. The relay uses only the already-authorized successful response and the bound project path. It does not mint authority, impersonate a user, or call a privileged internal mutation endpoint. Metrics are reconciled at the gateway so `sseActive` reflects the externally reachable secure streams rather than the now-shielded predecessor stream registry.

This boundary is intentionally transitional. A later bounded cleanup may move the shared realtime event bus below both core and gateway, but that refactor is not required to remove broad browser URL credentials safely and would materially increase this security slice's blast radius.

## TDD and exact evidence chronology

- `65504f82edf5f30b4f8fbd1215c50e14073eb013`: regression-first client/API contract registered before production implementation. The exact-head Server Tests failed because `stream-access-grant.js` did not yet exist, proving the client regression discriminated the absent behavior.
- `f34756b0b64c87587825e738ba923bacba8c1104`: strengthened the API regression to require a real successful project write to fan out its exact resulting optimistic-concurrency version through the secured SSE channel.
- `f711a21285c58c16d8a56a68b25ae7a25ee7af75`: production implementation added the exchange client, one-time reconnect controller, EventSource compatibility bridge, gateway stream redemption, secure event relay, static module serving, and gateway metrics reconciliation. Unit tests on this exact head passed, including the new stream client test. API execution then stopped on the predecessor smoke assertion that still expected a valid session JWT in the query string to return HTTP 200.
- `e0b123453a84cc0bd5ff6e418a6810b4277a656f`: corrected that stale smoke contract without weakening the route: legacy query-token transport must return HTTP 401, capable clients retain direct Authorization-header SSE, and unauthenticated SSE remains HTTP 401.

Only terminal exact-current-head evidence is release evidence. Queued, pending, cancelled, skipped-required, stale, predecessor-head, synthetic-only, model-only, or status-only results are non-passing.

## Acceptance contract

The slice is acceptable only when all of the following remain true on the unchanged integration candidate:

1. Browser code never sends the broad session secret in the EventSource URL; the broad secret appears only in the authenticated grant-exchange header.
2. The grant response URL is exact-origin, exact-project, fragment-free, credential-free, has one `grant` key, and contains a 43-character base64url secret.
3. A wrong-project redemption fails without consuming a grant that is otherwise still valid for its bound project.
4. A successful redemption is single-use and cannot be replayed.
5. Session revocation or membership loss prevents mint/redeem according to the access-grant domain's live membership-version contract.
6. Native reconnect never reuses a consumed grant; every retry performs a fresh authenticated exchange.
7. A normal authorized project update while connected produces an SSE `{ "type": "update", "version": <exact resulting version> }` event without exposing actor credentials.
8. Existing direct Authorization-header API streaming continues to work and an absent credential fails closed.
9. Repository-native unit/API/browser tests, dependency review, vulnerability scanning, deterministic security gates, owned coverage, and applicable protected-base rules all pass on the same unchanged head before integration.

## Rollback

Rollback means reverting the PR #513 semantic slice and restoring the prior protected behavior only as an emergency compatibility action; it must **not** be represented as a security-safe steady state because the predecessor browser flow places a broad bearer credential in the URL. If rollback is required operationally, disable the affected browser realtime feature or place it behind a controlled compatibility boundary while a corrected grant path is restored. Never weaken the deterministic route checks or reintroduce query-token acceptance merely to make a legacy test green.

## Standards and primary sources

The implementation decision is grounded in final RFC Editor publications. The RFC Editor also exposes an `RFC 10017` browser-applications publication-transition page dated July 2026 while its queue surface still describes the document as RFC-to-be/final-review; because those authoritative surfaces are not yet internally consistent, this slice does **not** depend on RFC 10017 being a final published BCP. It is supplementary evidence only. RFC 6750 and RFC 9700 are the normative final references used here.

### APA 7 references

Jones, M., & Hardt, D. (2012). *The OAuth 2.0 Authorization Framework: Bearer Token Usage* (RFC 6750). Internet Engineering Task Force. https://doi.org/10.17487/RFC6750

Lodderstedt, T., Bradley, J., Labunets, A., & Fett, D. (2025). *Best Current Practice for OAuth 2.0 Security* (BCP 240; RFC 9700). Internet Engineering Task Force. https://doi.org/10.17487/RFC9700

Parecki, A., De Ryck, P., & Waite, D. (2026). *OAuth 2.0 for Browser-Based Applications* (RFC-to-be 10017, publication-transition material). Internet Engineering Task Force / RFC Editor. Research-only supplementary reference pending consistent final-publication status across RFC Editor surfaces.
