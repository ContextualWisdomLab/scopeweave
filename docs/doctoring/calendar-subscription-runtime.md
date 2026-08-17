# Calendar subscription runtime composition

Status: **active stacked child; not shipped on protected `develop`**.

Issue: #413. Parent persistence authority: PR #541, which itself depends on the calendar-subscription domain in PR #539.

## Buyer/security outcome

The protected calendar feed still accepts a general ScopeWeave session credential in a URL query parameter. That credential carries substantially more authority than a calendar reader needs and may be exposed by URL-handling systems. The active runtime child composes the separately reviewed calendar credential domain and SQLite persistence into the production server boundary so an operator can create, list, rotate, and revoke a reusable project-calendar credential whose authority is fixed to `calendar_read` for one project and the `scopeweave:calendar` audience.

This slice deliberately remains a staged migration. It adds the durable subscription path but retains the existing `token=` calendar compatibility path temporarily for existing clients. That compatibility path is no longer treated as an independent authentication implementation: it passes through the core `/api/me` authentication boundary, which performs the same database-backed `token_version` revocation checks as normal bearer sessions and PAT handling. The customer management UI and final removal of broad session credentials from calendar URLs remain later #413 work.

## Runtime composition boundary

`server/runtime_app.mjs` is a thin composition wrapper around `server/app.mjs` rather than a copy of the existing application. At bootstrap it:

1. installs the normalized calendar-subscription schema supplied by the parent SQLite adapter;
2. installs an idempotent membership-removal trigger that marks affected reusable subscriptions revoked and writes secret-free revocation evidence before membership deletion commits;
3. wires project management authorization, the live membership/session epoch, cryptographic randomness, the SQLite repository, and the existing audit log into `createCalendarSubscriptionService(...)`; and
4. registers only the calendar-management and calendar-feed routes before delegating every unrelated request to the existing core app.

`server/server.mjs` uses this composition only on the active child branch. Protected `develop` remains unchanged until the prerequisite stack and this child integrate under normal governance.

## Credential and transport contract

The create and rotate responses expose the 256-bit random subscription secret exactly once. Lifecycle listing never returns the plaintext secret, its SHA-256 hash, or the membership epoch. The returned feed path uses `subscription=` rather than `token=` and the reusable credential cannot authorize JSON APIs, SSE, attachments, another project, or another audience.

A subscription feed request is accepted only when all of these are true:

- the secret has the required format and resolves to the current stored SHA-256 hash;
- project, `calendar_read` purpose, and `scopeweave:calendar` audience match;
- the stored issuance membership epoch equals the live `membership_id:token_version` epoch;
- the credential is neither expired nor revoked;
- the SQLite atomic usage transition independently rechecks the same live epoch; and
- no session query token or `Authorization` credential is mixed into the same subscription request.

Successful subscription-feed responses set `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. The application does not log request bodies or credential values. Calendar values are escaped for RFC 5545 text and all-day `DTEND` remains exclusive.

## Revocation and recovery

Rotation atomically replaces the current stored hash, so the previous feed URL stops working immediately. Explicit revocation preserves first-transition semantics from the parent domain/adapter.

A `logout-all` or other `token_version` advance changes the live membership/session epoch. Existing reusable calendar credentials from the previous epoch fail authorization immediately; an authorized operator may then rotate the same subscription to bind a new secret to the new epoch. This gives account-level revocation an immediate effect without silently deleting operator-visible subscription state.

Membership removal is stronger. The bootstrap trigger writes a `revoked` event to `calendar_subscription_audit_outbox` and sets `revoked_at_ms` on each affected active subscription within the same SQLite transaction as the membership deletion. Remove-then-rejoin therefore cannot resurrect a reusable secret even if membership identity is later recreated. The core `member.remove` audit record retains the administrative actor, while the calendar outbox retains credential-level revocation evidence without secret material.

## Compatibility and retirement plan

The legacy `token=` calendar path remains an explicit compatibility state, not the target design. During this phase it supports the same current session/PAT authentication semantics as the core API and rejects a request that supplies both query-token and `Authorization` authority. Stale session tokens fail after `token_version` revocation.

The next product slice is the reviewed customer management interaction from the calendar-domain Figma contract. After the UI/client migration and operational acceptance demonstrate that supported calendar clients can create/save/rotate/revoke the dedicated feed URL, the legacy query-session path can be removed with a separate exact-head regression. Rollback must never represent broad session-JWT query transport as the preferred steady-state design.

## TDD and executable acceptance

The runtime API contract was committed before the production composition existed. The first test registered `tests/api/calendar-subscription-runtime.test.mjs` in the canonical API suite while the tested management routes were absent from `server/app.mjs`, establishing the RED boundary before the wrapper implementation.

The current regression covers:

- unauthenticated and cross-tenant management rejection;
- stable invalid-request status mapping;
- create/list and one-time secret disclosure;
- project/purpose/audience-bound feed authorization;
- private/no-store/no-referrer/nosniff response policy;
- mixed-credential fail-closed behavior;
- rotation and immediate previous-secret invalidation;
- explicit revocation;
- `logout-all` invalidation followed by authorized epoch re-binding;
- transactional membership-removal revocation plus audit-outbox evidence;
- staged legacy query-token compatibility through current database-backed session authority; and
- coverage-script registration for the production composition module.

Hosted exact-head CI remains authoritative for full statement/branch coverage and broad regression evidence. No predecessor-head result transfers after this branch or any prerequisite head moves.

## Rollback

Before protected integration, rollback is branch-local. After integration, a runtime rollback may disable the new lifecycle endpoints and restore the previous production composition only if incident containment requires it, but it must preserve the normalized subscription and audit data and must not delete revocation/rotation evidence. Re-enabling broad query-session calendar credentials as a permanent security posture is not an acceptable rollback target. Any schema removal requires a separately reviewed data migration/recovery plan.

## References

Desruisseaux, B. (Ed.). (2009). *Internet calendaring and scheduling core object specification (iCalendar)* (RFC 5545). Internet Engineering Task Force. https://doi.org/10.17487/RFC5545

Jones, M., & Hardt, D. (2012). *The OAuth 2.0 authorization framework: Bearer token usage* (RFC 6750). Internet Engineering Task Force. https://doi.org/10.17487/RFC6750

Lodderstedt, T., Bradley, J., Labunets, A., & Fett, D. (2025). *Best current practice for OAuth 2.0 security* (BCP 240; RFC 9700). Internet Engineering Task Force. https://doi.org/10.17487/RFC9700

Sheffer, Y., Hardt, D., & Jones, M. (2020). *JSON Web Token best current practices* (BCP 225; RFC 8725). Internet Engineering Task Force. https://doi.org/10.17487/RFC8725
