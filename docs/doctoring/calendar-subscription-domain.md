# Calendar subscription credential domain

Status: **active stacked PR work; not shipped on protected `develop`**.

Issue: #413.

## Why this slice exists

Protected `develop` still accepts the general ScopeWeave session credential in the query string of `/api/projects/:id/calendar.ics`. Calendar clients commonly require a reusable URL rather than an `Authorization` header, but reusing a broad session JWT gives that URL the authority of a user session and exposes an unnecessarily powerful credential to URL-handling surfaces such as browser history, copied links, reverse proxies, observability systems, and downstream calendar clients.

The IETF's OAuth bearer-token guidance is not a specification for ScopeWeave calendar subscriptions. It is relevant threat evidence: RFC 6750 warns against URI-query bearer-token transport because URLs are likely to be logged, while the current OAuth 2.0 Security BCP (RFC 9700, January 2025) further restricts token exposure and recommends limiting token privilege and audience. RFC 8725 provides current BCP guidance for JWT validation. ScopeWeave therefore treats the existing session-JWT calendar URL as a legacy authority boundary to retire, not as the target reusable-subscription design.

This bounded slice introduces only a framework-neutral lifecycle domain. It does **not** change the protected calendar route, create database tables, migrate stored data, add HTTP endpoints, or implement the management UI. The product-interaction prerequisite from issue #413 is now captured in the Figma design described below; future UI implementation must conform to that reviewed interaction contract and the eventual API semantics rather than inventing an independent credential lifecycle.

## Figma interaction design

The editable product contract is `ScopeWeave Calendar Subscription Management — Issue 413`: <https://www.figma.com/design/EwcePYFQ85DjBLhFfMXLvI>.

The design is active-PR evidence, not shipped-product evidence. It uses the current protected ScopeWeave visual tokens and reusable button/status components and covers seven explicit states:

1. interaction/security contract;
2. subscription management list;
3. creation dialog;
4. one-time secret reveal;
5. rotation confirmation;
6. revocation confirmation; and
7. empty state.

The interaction contract requires a recognizable subscription name and explicit expiry, read-only/current-project purpose copy, one-time secret display on create or rotate, an explicit copy/save acknowledgement, lifecycle metadata without stored secret material, immediate old-secret invalidation on rotation, named destructive consequences on revocation, and next-action-oriented failure/recovery copy. Active, expired, and revoked states use text in addition to color.

Accessibility acceptance is part of the design rather than a later visual-polish step: the dialog title is the accessible name, helper/error content is associated with its control, focus enters the dialog and returns to its invoker, Escape never silently commits, primary actions retain visible focus, and copy/status feedback is announced without moving focus. UI implementation must add executable browser acceptance for these interactions before the Figma design can be represented as shipped behavior.

## Domain contract

`server/calendar_subscription_domain.mjs` defines one fixed resource audience, `scopeweave:calendar`, one fixed purpose, `calendar_read`, and an injected service with five operations: create, list, authorize, rotate, and revoke. The purpose is the buyer-visible authority boundary: a thin route may mint an ICS/calendar-feed principal from it and must not treat that principal as session-equivalent access to JSON APIs, SSE, attachments, or another project. RFC 5545 remains the interchange format for the eventual feed; this domain only issues the reusable credential that will later authorize that feed.

A newly created or rotated subscription secret is generated from 32 random bytes and encoded as unpadded base64url. The plaintext secret is returned only by `create()` or `rotate()`. Only its SHA-256 hash crosses the repository port. Audit events contain the independently random correlation identifier (`csub_` plus 128 random bits), actor/resource identifiers, purpose, audience, and lifecycle metadata, but never the plaintext secret or its hash. Repeat revocation keeps the original `revoked_at_ms`. Adapters must set `revocation_applied: true` only on the first transition so a same-millisecond retry cannot emit a second audit event.

The reusable credential is deliberately separate from the short-lived `stream` and `attachment_view` grant domain in PR #506. A calendar subscription needs an operator-visible lifecycle—name, creation time, last-use time, expiry, rotation, revocation, purpose/resource, and status—whereas the short-lived access-grant domain is one-time and capped at five minutes. Reusing either the general session JWT or the one-time grant lifecycle would collapse materially different authority and recovery semantics.

Creation and lifecycle management require project-management authorization. Every secret use re-checks active membership and passes the *issuance* membership version stored on the row into `recordUsageAtomically(...)`. The service also fail-closes when live membership no longer equals that issuance epoch, so remove-then-rejoin cannot revive an unrevoked secret. `rotateSubscriptionAtomically(...)` receives the *current* live membership version so a still-authorized operator can re-bind after rejoin while invalidating the previous secret. Production adapters must, in the same transaction, compare the supplied version with live membership, compare usage against the row's stored epoch, and reject wrong project/audience/purpose, exact expiry (`expires_at_ms <= now_ms`), and a non-null `revoked_at_ms`. The service fail-closes unless the returned row is active. Membership-removal paths must atomically revoke affected calendar subscriptions; that revoke-on-change path is mandatory, not a substitute for the epoch comparison.

Expiry is mandatory, exact expiry is unusable, and create/rotate reject a lifetime longer than 366 days from `nowMs` so a buggy caller cannot persist a decades-long feed secret. The product/API layer may choose a shorter policy and must communicate it to operators. Rotation invalidates the previous secret as part of one atomic repository transition; revocation is idempotent from the operator perspective. Listing returns safe lifecycle metadata only and never permits the stored secret, secret hash, or membership-version value to be redisplayed.

Audit delivery occurs only after the durable repository transition and is best-effort at this framework-neutral boundary. An audit transport outage must not convert an already completed secret creation, rotation, revocation, or usage record into a client-visible failure that encourages unsafe retry. Production persistence that requires durable evidence should couple the state change to a transactional audit outbox.

## Persistence boundary for the follow-up adapter

Issue #413 owns the intended normalized durable objects `calendar_subscriptions`, `subscription_rotations`, and `subscription_usage_events`. This PR does not create them. The separate schema-migration work in PR #500 establishes migration identity/fail-closed generation handling for the broader database modernization and must remain the schema-transition authority rather than being duplicated here.

A future adapter must preserve at least these invariants:

- `calendar_subscriptions` contains the subscription identity, project/subject binding, name, fixed `calendar_read` purpose, fixed audience, current secret hash, issuance membership version, creation/expiry/last-use/rotation/revocation metadata; plaintext secrets are never persisted.
- `subscription_rotations` records non-secret correlation/evidence for each successful rotation without retaining previous plaintext secrets.
- `subscription_usage_events` records bounded operational usage evidence suitable for access/export investigation without turning request URLs or secrets into logs.
- create, rotate, revoke, and last-use updates are transactionally consistent with their lifecycle evidence, and membership invalidation cannot race a successful use or rotation into continued access.
- owned database object names remain descriptive multiword `snake_case` and the eventual relational design is normalized rather than embedding lifecycle history in an opaque JSON column.

## Verification and traceability

TDD began at commit `c86c878f6e9876fe9ca5c85d8b7e8b25fcb5ed77`, whose behavior contract imported an absent `server/calendar_subscription_domain.mjs`; the focused Node execution failed RED with `ERR_MODULE_NOT_FOUND`. Commit `1210d52225fa25e9f122e23fe80578334e64cff8` supplied the production domain. Commit `1bb891b9c34b997c0b618857093bba41a967cbe6` added failure-boundary coverage for port contracts, invalid identifiers/names/expiry, malformed membership versions, authorization denial, invalid clock/random sources, safe listing states, malformed/unknown/wrong-boundary credentials, and atomic lifecycle rejection. Both focused Node test files passed locally after implementation.

The canonical repository coverage producer now instruments `server/calendar_subscription_domain.mjs` and executes both calendar-domain test files. Local `c8` evidence is unavailable in the current execution environment because the package is not locally cached; therefore hosted exact-head Istanbul evidence remains mandatory and no local statement/branch percentage is claimed as passing evidence.

The protected `develop` truth remains unchanged by this active branch. Before integration, the exact child head must be reconciled after PR #506, all applicable repository/organization checks and security/dependency/supply-chain evidence must be terminal-success on the unchanged current head, owned production coverage must satisfy the repository contract, every valid review finding must be resolved, and the live rulesets' qualifying independent current-head/last-push approval must exist. Predecessor-head, skipped-required, neutral, synthetic, status-only, or model-only evidence does not transfer.

## Rollback

Until a persistence/route slice exists, rollback is code-only: remove this module, its focused tests, coverage registrations, doctoring entry, and changelog line together. No database migration or credential invalidation is required because this slice cannot yet issue a production calendar subscription. Once persistence is added, rollback must preserve the durable revocation/rotation history and must never restore the broad session-JWT query credential as the security-safe steady state.

## References

Desruisseaux, B. (Ed.). (2009). *Internet calendaring and scheduling core object specification (iCalendar)* (RFC 5545). Internet Engineering Task Force. https://doi.org/10.17487/RFC5545

Jones, M., & Hardt, D. (2012). *The OAuth 2.0 authorization framework: Bearer token usage* (RFC 6750). Internet Engineering Task Force. https://doi.org/10.17487/RFC6750

Lodderstedt, T., Bradley, J., Labunets, A., & Fett, D. (2025). *Best current practice for OAuth 2.0 security* (BCP 240; RFC 9700). Internet Engineering Task Force. https://doi.org/10.17487/RFC9700

Sheffer, Y., Hardt, D., & Jones, M. (2020). *JSON Web Token best current practices* (BCP 225; RFC 8725). Internet Engineering Task Force. https://doi.org/10.17487/RFC8725
