# Schedule reason-event authoritative project-version boundary

## Status and scope

This document describes **active stacked pull-request work**, not protected-`develop` shipped truth. The slice is stacked on PR #519 exact current head `3922071464c0feb9f643ce99dd0d7a12be5886fa` and connects that reason-event repository port to ScopeWeave's existing authoritative project-plan concurrency field, `projects.version`, without introducing a parallel work-item version table.

ScopeWeave currently persists each project plan in `projects.tasks_json` and uses the project row's integer `version` for optimistic concurrency. A terminal reason event refers to one work-item ID inside that exact plan snapshot. The adapter therefore verifies tenant, project, work-item membership, and expected project version before conditionally advancing the project row. It does not rewrite task JSON; reason facts remain in the normalized relations owned by PR #519.

## Authority and concurrency contract

`server/schedule_reason_event_project_version.mjs` exposes a typed resource token `project_version:<positive-safe-integer>` so database version authority is not confused with unrelated resource-version families. External organization/project identities must be canonical positive decimal strings; lossy alternatives such as leading-zero, signed, whitespace-padded, fractional, or scientific notation fail closed before database mutation. Work-item IDs must be bounded, non-blank text without control characters; whitespace-only authority therefore fails closed even if the adapter is invoked below the normal domain-validation boundary.

A transition succeeds only when all of the following remain true on the same SQLite connection:

- the exact `projects.id` and `projects.org_id` row exists;
- the stored project version equals the authorization-bound expected version;
- the exact non-blank work-item ID exists exactly once in the current `tasks_json` array; and
- the current version can advance without exceeding JavaScript's safe-integer range.

The conditional `UPDATE` increments only the project version and timestamp. Stale version, wrong tenant/project, missing work-item, or an update race returns a non-advanced result. Blank or control-character work-item authority, malformed task JSON, duplicate work-item identity, malformed authority tokens, or unsafe stored versions throw stable fail-closed errors. When invoked from the PR #519 repository inside its savepoint, a later event/audit failure rolls the project-version update back with the normalized event records.

## TDD and executable evidence

- The initial RED contract was captured on `a11c99db7fe379a60fc01702bbca8bf45a1915a4`; repository-native `unit-and-api` failed with `ERR_MODULE_NOT_FOUND` for `server/schedule_reason_event_project_version.mjs`.
- The RED branch was reconciled non-destructively with repaired persistence parent `5103c79109d08553d6fe5c679cdf0a16fa989609` before production implementation; the current stack has since been reconciled again to PR #519 head `3922071464c0feb9f643ce99dd0d7a12be5886fa`.
- The contract covers exact successful advancement without task-data rewriting; stale, cross-tenant, cross-project, and missing-work-item failures; malformed/ambiguous numeric identities and version tokens; malformed or duplicate task snapshots; predecessor-version replay; and the `Number.MAX_SAFE_INTEGER` non-advancement boundary.
- Defense-in-depth RED `63b67b17355c5beae41b5c14b83d214b12691a62` added a whitespace-only work-item authority case. Hosted `unit-and-api` failed on that exact head while `cloud-e2e` remained green, proving the persistence adapter accepted an invalid boundary shape below the domain layer.
- GREEN `dc8d1b88af48b8f00d4bf4412ed79cb6d9e8c23a` rejects blank work-item authority before database lookup; hosted `unit-and-api` passed on that exact head.
- Fresh hosted GREEN evidence on the final exact head remains authoritative; predecessor or RED-head checks do not transfer.

## Security, privacy, and rollback

The adapter does not derive authorization from browser input and does not expose tenant-existence details beyond the repository's stable advanced/non-advanced contract. It stores no secret or additional PII. It preserves the existing project/task persistence model and creates no schema object. Rollback before integration removes this adapter, its focused tests/coverage wiring, this record, and its Unreleased CHANGELOG entry. Durable reason-event rows remain owned by the parent persistence slice.

## Standards boundary

SQLite's transactional/savepoint semantics and conditional-update behavior are the operative technical basis for same-connection atomicity. NIST SP 800-53 Rev. 5 AC-3 and AU-family controls remain control-design context for access enforcement and auditable state change; this implementation does not claim certification or that NIST prescribes ScopeWeave's version-token format.

## References

National Institute of Standards and Technology. (2025). *Security and privacy controls for information systems and organizations* (NIST Special Publication 800-53 Rev. 5, Release 5.2.0). https://doi.org/10.6028/NIST.SP.800-53r5

SQLite Consortium. (n.d.). *Atomic commit in SQLite*. SQLite. https://www.sqlite.org/atomiccommit.html

SQLite Consortium. (n.d.). *Savepoints*. SQLite. https://www.sqlite.org/lang_savepoint.html
