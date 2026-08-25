# Schedule reason-event persistence evidence

## Status and scope

This document describes **active pull-request work only**. Protected `develop` does not yet ship this SQLite adapter. The slice is stacked on PR #518 and has been reconciled against exact authorization parent `4b17e7d15c02002bb985e9d7b28fa06e78b4afab`, including the domain-side prohibition on self-approved cancellation.

The slice owns one bounded persistence responsibility: atomically preserve an already-authorized terminal schedule reason event, any verified cancellation approval evidence, an immutable audit record, and the authoritative resource-version transition that makes the write current. It does not add HTTP routes, browser authority, a second work-item source of truth, schedule-variance mathematics, forecasting, or decision UI.

## Persistence contract

`server/schedule_reason_event_sqlite.mjs` installs three normalized relations:

- `schedule_reason_events`: immutable reason facts with tenant/project/work-item identity, prior and committed resource versions, reason vocabulary, actor, trusted timestamps, and authorization identity.
- `schedule_reason_event_approval_records`: optional cancellation approval evidence keyed by event ID.
- `schedule_reason_event_audit_records`: one immutable audit identity/action for the event without duplicating event facts.

Owned database objects use descriptive multiword snake_case names. The adapter deliberately does **not** create or own an authoritative work-item version table. Its injected `advanceResourceVersion` function must update the existing authoritative store synchronously on the same SQLite connection and inside the same savepoint. The version transition, event insert, optional approval insert, and audit insert therefore commit or roll back together.

## Concurrency, rollback, and failure behavior

The repository receives the exact `expectedResourceVersion` already authorized by the domain boundary. A stale transition, missing/blank resulting version, or non-advancing transition fails closed before durable event insertion. It does not retry against a newer resource version because that would broaden authority beyond the decision that was actually checked.

A named SQLite savepoint wraps the version transition and persistence writes. The realistic regression deliberately forces an audit uniqueness failure after a real version update and proves both the version and all child persistence roll back. Cleanup also preserves the causal write error when rollback cleanup itself fails.

## TDD and verification evidence

- RED `393e8a48b4815a0fdbb2104fc3c4d846f65de057` introduced the persistence behavior contract before the production module and failed with `ERR_MODULE_NOT_FOUND`.
- GREEN `f3aa61ae6cd0caa774386be3a8e3959ab210501f` added the adapter.
- `f527bd778a2ae19f3c216b0f427dc9754824d7f7` and `40d303933d7e3306b6502098b832691f5d6dd864` registered and locked canonical unit/c8 evidence.
- The branch was subsequently reconciled with the repaired #518 parent; predecessor-head evidence is historical and fresh exact-head hosted evidence is required.

## Security and integration boundary

The adapter preserves tenant/project/work-item identifiers from the already-authorized domain event, rejects non-cancellation approval confusion, fails stale optimistic-concurrency writes closed, and requires an opaque generated audit identity. Production bootstrap must keep SQLite foreign keys enabled because enforcement is connection-scoped.

Do not integrate independently of #518/#517/#515. Issue #287 remains open. Subsequent work still needs authenticated server/API wiring, an authoritative same-connection project/work-item version adapter, Rust-first deterministic schedule-variance computation with explicit missingness denominators, and buyer-facing decision views.

## References

SQLite Consortium. (n.d.). *CREATE TABLE*. SQLite. https://www.sqlite.org/lang_createtable.html

SQLite Consortium. (n.d.). *Foreign key support*. SQLite. https://www.sqlite.org/foreignkeys.html

SQLite Consortium. (n.d.). *Savepoints*. SQLite. https://www.sqlite.org/lang_savepoint.html

SQLite Consortium. (n.d.). *SQLite is transactional*. SQLite. https://www.sqlite.org/transactional.html
