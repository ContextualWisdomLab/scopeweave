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

Successful subscription-feed responses set `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. The application does not log request bodies or credential values. Calendar values are escaped for RFC 5545 text and all-day `DTEND` remains exclusive. Every emitted RFC 5545 content line is folded to at most 75 UTF-8 octets using `CRLF` plus one SPACE for continuation, and folding iterates Unicode code points so it never splits a UTF-8 multi-octet character. Unfolding therefore reconstructs the complete customer-visible project/task text instead of truncating or corrupting non-ASCII names.

Project task persistence predates the calendar runtime and can contain malformed or impossible date strings. Feed rendering therefore treats persisted task dates as untrusted input: a task is emitted only when both dates are canonical real `YYYY-MM-DD` UTC calendar days and its exclusive next-day `DTEND` is itself representable by RFC 5545's four-digit basic `DATE` form. Invalid months, normalized impossible days, and the `9999-12-31` upper boundary are omitted rather than causing HTTP 500 responses, silently changing the scheduled day, or emitting an extended-year value such as `+01000001`.

## Revocation and recovery

Rotation atomically replaces the current stored hash, so the previous feed URL stops working immediately. Explicit revocation preserves first-transition semantics from the parent domain/adapter.

A `logout-all` or other `token_version` advance changes the live membership/session epoch. Existing reusable calendar credentials from the previous epoch fail authorization immediately; an authorized operator may then rotate the same subscription to bind a new secret to the new epoch. This gives account-level revocation an immediate effect without silently deleting operator-visible subscription state.

Membership removal is stronger. The bootstrap trigger writes a `revoked` event to `calendar_subscription_audit_outbox` and sets `revoked_at_ms` on each affected active subscription within the same SQLite transaction as the membership deletion. Remove-then-rejoin therefore cannot resurrect a reusable secret even if membership identity is later recreated. The core `member.remove` audit record retains the administrative actor, while the calendar outbox retains credential-level revocation evidence without secret material.

## Compatibility and retirement plan

The legacy `token=` calendar path remains an explicit compatibility state, not the target design. During this phase it supports the same current session/PAT authentication semantics as the core API and rejects a request that supplies both query-token and `Authorization` authority. Stale session tokens fail after `token_version` revocation.

The next product slice is the reviewed customer management interaction from the calendar-domain Figma contract. After the UI/client migration and operational acceptance demonstrate that supported calendar clients can create/save/rotate/revoke the dedicated feed URL, the legacy query-session path can be removed with a separate exact-head regression. Rollback must never represent broad session-JWT query transport as the preferred steady-state design.

## TDD and executable acceptance

The runtime API contract was committed before the production composition existed. The first test registered `tests/api/calendar-subscription-runtime.test.mjs` in the canonical API suite while the tested management routes were absent from `server/app.mjs`, establishing the RED boundary before the wrapper implementation.

Two later feed-validity repairs were also established with executed RED evidence before production changes. Test-only `44eec30eb31f43ce9658c97d99af12f4f4d09ac0` persisted `2026-13-01` and `2026-02-30`; Server Tests run `32088800210`, job `95566742208`, reproduced the `RangeError: Invalid time value` feed failure before `isCalendarDay()` was hardened. Test-only `fa55b6f535d6f2c2f5a3420d31f1ae3425b38173` then persisted `9999-12-31`; Server Tests run `32089288786`, job `95568160158`, proved the feed emitted the malformed `DTEND;VALUE=DATE:+01000001` before exclusive-end rendering was bounded. Production commit `f25941198928ad285a2165f7785f27c0fba3bc71` made the second regression GREEN; Server Tests run `32089452553` completed successfully with both `unit-and-api` and `cloud-e2e` passing, while Dependency Review `32089452544` and OSV Scanner `32089452867` also passed on that contributor head. These runs are causal evidence, not final merge authority after later head movement.

The interoperability repair was likewise test-first. Test-only head `e3bd931539f19ea342042a7c11aeaab78fe7af1e` added a long Korean task summary and required every physical iCalendar line to remain within 75 UTF-8 octets while unfolding preserved the complete Unicode value. Server Tests run `32583307921`, `unit-and-api` job `97055782749`, failed at the intended assertion because the renderer emitted an overlong line. Production commit `a73f974efc81085703fe3fe49233fce2162aebca` added UTF-8-safe RFC 5545 content-line folding. Server Tests run `32583381045` then completed successfully: `unit-and-api` job `97055956846` passed the registered API regression and the full unit/API suite, and `cloud-e2e` job `97055956941` passed. Dependency Review `32583381120` and OSV Scanner `32583381290` were also terminal success on that contributor head. The hosted Server Tests checked synthetic merge `cdac7ea7f6f61642d79b959691d74f2fe88317b9` (`Merge a73f974e... into 422f754e...`), so this is causal merge-result evidence rather than exact-contributor-head merge authorization until #523 reaches protected `develop`.

The current regression covers:

- unauthenticated and cross-tenant management rejection;
- stable invalid-request status mapping;
- create/list and one-time secret disclosure;
- project/purpose/audience-bound feed authorization;
- private/no-store/no-referrer/nosniff response policy;
- malformed, impossible, and unrepresentable-exclusive-end task-date omission;
- RFC 5545 UTF-8 content-line folding with complete Unicode text after unfolding;
- mixed-credential fail-closed behavior;
- rotation and immediate previous-secret invalidation;
- explicit revocation;
- `logout-all` invalidation followed by authorized epoch re-binding;
- transactional membership-removal revocation plus audit-outbox evidence;
- staged legacy query-token compatibility through current database-backed session authority; and
- coverage-script registration for the production composition module.

Hosted exact-head CI remains authoritative for full statement/branch coverage and broad regression evidence. Repository Server Tests still use GitHub's synthetic pull-request merge ref until the exact-head workflow repair in #523 is protected-integrated, so the bound contributor SHA plus the synthetic checkout identity must both be retained when interpreting current evidence. No predecessor-head result transfers after this branch or any prerequisite head moves.

## Rollback

Before protected integration, rollback is branch-local. After integration, a runtime rollback may disable the new lifecycle endpoints and restore the previous production composition only if incident containment requires it, but it must preserve the normalized subscription and audit data and must not delete revocation/rotation evidence. Re-enabling broad query-session calendar credentials as a permanent security posture is not an acceptable rollback target. Any schema removal requires a separately reviewed data migration/recovery plan.

## References

Desruisseaux, B. (Ed.). (2009). *Internet calendaring and scheduling core object specification (iCalendar)* (RFC 5545). Internet Engineering Task Force. https://doi.org/10.17487/RFC5545

Jones, M., & Hardt, D. (2012). *The OAuth 2.0 authorization framework: Bearer token usage* (RFC 6750). Internet Engineering Task Force. https://doi.org/10.17487/RFC6750

Lodderstedt, T., Bradley, J., Labunets, A., & Fett, D. (2025). *Best current practice for OAuth 2.0 security* (BCP 240; RFC 9700). Internet Engineering Task Force. https://doi.org/10.17487/RFC9700

Sheffer, Y., Hardt, D., & Jones, M. (2020). *JSON Web Token best current practices* (BCP 225; RFC 8725). Internet Engineering Task Force. https://doi.org/10.17487/RFC8725
