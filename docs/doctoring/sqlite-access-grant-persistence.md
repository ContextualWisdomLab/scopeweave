# SQLite access-grant persistence — active PR evidence

## Status and truth boundary

**Status:** active stacked PR; not protected-`develop` truth until its parent and this slice are independently reviewed, integrated, and merged.

This record covers the SQLite persistence adapter for the short-lived opaque access-grant domain introduced by #506 as part of #413. It does **not** claim that browser attachment viewing, SSE, or calendar subscription transport has already stopped carrying broad credentials. Runtime transport migration is a later slice and must not be inferred from this document.

## Buyer-visible security objective

ScopeWeave needs a durable one-time credential state machine before browser flows can replace general session JWTs in URLs with narrow grants. RFC 6750 warns against bearer credentials in page URLs because histories, logs, and other URL-handling infrastructure can disclose them. RFC 9700/BCP 240 strengthens current guidance: clients must not pass access tokens in URI query parameters in the described pattern. The adapter therefore persists only an irreversible token hash and the minimum authorization binding required to redeem one narrowly scoped grant.

A second requirement is evidentiary: a successful mint or one-time consume must not become durable without durable, secret-free security evidence of the same transition. The SQLite adapter therefore pairs usable-grant state with an immutable audit-outbox row in the same savepoint. This closes the parent domain's documented audit-durability obligation before any protected runtime begins issuing grants.

## Persistence contract

`server/access_grant_sqlite.mjs` owns three explicit SQLite ports and one bootstrap function:

- `installAccessGrantSchema(database)` installs the schema during database/process bootstrap, never inside an HTTP request path.
- `createSqliteAccessGrantRepository(database)` persists hash-only grants, persists the matching immutable audit event, and consumes grants with one conditional `UPDATE` plus matching consume evidence under one savepoint.
- `createSqliteAccessGrantAuthorizationPort(database)` verifies project membership and, for `attachment_view`, the exact ready attachment before minting.
- `createSqliteAccessGrantMembershipPort(database)` returns an opaque `membership_id:token_version` value that is rechecked inside the atomic consume statement.

The persisted `access_grants` relation is in third normal form for this bounded domain: one row represents one grant, non-key attributes describe only that grant, and user/project/attachment facts remain referenced by foreign keys rather than copied into repeated descriptive columns.

`access_grant_audit_outbox` is an immutable event relation: each row represents one security transition, and its subject/project/resource identifiers are event-time evidence rather than mutable resource attributes. It intentionally does not carry foreign keys to live resources because deleting a user, project, or attachment must revoke the usable grant without erasing historical access-control evidence.

### Owned database objects

- `access_grants`
- `access_grant_token_hash_index`
- `access_grant_subject_resource_index`
- `access_grant_audit_outbox`
- `access_grant_audit_delivery_index`

All newly owned objects use descriptive multi-word snake_case names. Existing legacy single-word objects are outside this slice and remain tracked separately by #433.

## Secret and lifecycle boundaries

The database stores `token_hash` but never the plaintext grant secret. Each usable-grant row binds the subject, project, purpose, audience, optional attachment, issue/expiry timestamps, and use/revocation timestamps. `ON DELETE CASCADE` makes deletion of a subject, project, or bound attachment an immediate lifecycle revocation for dependent usable grants.

Audit-outbox rows store only the grant correlation ID and non-secret authorization/event facts. The plaintext secret and its hash are both absent from the outbox. Audit evidence deliberately survives lifecycle deletion of the underlying attachment or usable grant.

SQLite foreign-key enforcement is explicitly enabled by the existing data bootstrap. The adapter relies on SQLite's documented foreign-key action semantics for resource deletion and on its transactional isolation/serialized writes for one-winner state transitions.

## Atomic one-time consumption

The consume operation is a single conditional `UPDATE access_grants SET used_at_ms = ? ...` statement. A row can move from unused to used only when all conditions hold together:

1. token hash matches;
2. purpose and audience match;
3. project and optional attachment binding match;
4. `used_at_ms` and `revoked_at_ms` are still null;
5. current time is strictly before expiry;
6. the subject is still a member of the project's organization; and
7. current `membership_id:token_version` equals the value observed immediately before consumption.

Because the unused-state predicate and membership-version predicate participate in the same write statement, two concurrent consumers cannot both perform the unused→used transition. A membership removal/re-add changes the durable membership identity; logout-all/session-version invalidation changes `token_version`. Either change makes an already minted but unused grant fail closed.

The consume `UPDATE` and the corresponding `consumed` audit-outbox insert execute under one SQLite savepoint. If durable audit evidence cannot be inserted, the savepoint rolls the consume transition back, leaving the grant unused and safely retryable after the durable boundary recovers. Mint uses the same pattern: the secret is not returned from a successful repository call unless both the hash-only usable-grant row and `minted` audit evidence commit.

Savepoints are used rather than assuming ownership of the whole database transaction, so the adapter can remain atomic when called standalone or inside a future wider SQLite transaction.

The follow-up runtime slice must retain this exact atomic boundary rather than reintroducing a check-then-use race in an HTTP handler.

## Audit outbox handling contract

`access_grant_audit_outbox` is durable local evidence first and an eventual external-audit delivery queue second. Rows are append-only in this slice and include `delivered_at_ms` for a future bounded drainer. No drainer is claimed here, and no protected runtime currently depends on one.

A later drainer must:

- select only undelivered rows in stable event order;
- deliver without secrets or token hashes;
- mark delivery only after the destination acknowledges the event;
- use bounded retries/backoff without blocking grant mint/redeem request paths; and
- retain the row according to the repository's reviewed audit-retention policy rather than deleting evidence on successful delivery.

The parent domain's best-effort injected audit sink may still emit immediate operational telemetry, but it is no longer the only evidence boundary for the SQLite adapter.

## Authorization and tenant nondisclosure

Attachment-view mint authorization requires all of the following in one database lookup: current project membership, exact project/attachment ownership, and `SUCCEEDED` attachment readiness. Failure is deliberately thrown through the domain port so the domain maps inaccessible resources to the same not-authorized/not-found response class instead of revealing another tenant's attachment existence.

Project-only purposes such as `stream` require current project membership and carry no attachment binding.

## TDD evidence

The first two commits on the stacked branch were intentionally RED: `tests/unit/access-grant-sqlite.test.mjs` imported a not-yet-existing `server/access_grant_sqlite.mjs`, and the canonical test/coverage scripts were updated to execute that contract before production implementation existed. Hosted workflows for that predecessor head were cancelled after later branch movement; cancelled evidence is not promoted to passing.

The audit-durability hardening was also test-first. `tests/unit/access-grant-audit-outbox.test.mjs` first required a not-yet-existing outbox and transactional rollback semantics. The implementation then added the immutable outbox relation and savepoint-coupled mint/consume transitions; the pre-existing schema-name regression was updated only because the new compliant outbox/index became intentionally owned database objects.

Current tests cover:

- hash-only persistence and absence of a plaintext-secret column;
- successful single redemption followed by replay rejection;
- token-version invalidation;
- membership removal/re-add invalidation;
- tenant-nondisclosing cross-tenant authorization;
- rejection of not-ready attachment grants;
- attachment-delete cascade revocation;
- restart/reopen persistence with exactly-once redemption afterward;
- null-resource stream grants and project-only authorization;
- unknown-hash and wrong-resource failures without burning the correct grant;
- bootstrap idempotence and missing-database failures;
- membership-port fail-closed behavior;
- schema lifetime constraints;
- mint and consume audit evidence with no plaintext secret;
- rollback of a mint when its durable audit insert fails;
- rollback of a consume when its durable audit insert fails, followed by successful retry after recovery;
- audit-evidence retention after attachment lifecycle deletion; and
- canonical `c8` registration for all adapter/audit behavior files and the production adapter.

A local Node 22 direct adapter probe on the earlier persistence implementation exercised schema installation, authorization, membership versioning, insert/find, successful conditional consume, and replay rejection. That probe predates the transactional-audit hardening and is not promoted to current-head evidence. Hosted exact-current-head CI remains authoritative for merge decisions.

## Migration, rollback, and compatibility

The schema is installed only after referenced core tables exist. `CREATE TABLE/INDEX IF NOT EXISTS` makes bootstrap idempotent for existing self-hosted databases. This slice adds no destructive migration and does not rename legacy objects.

Rollback removes the adapter import/bootstrap call, `access_grants` and `access_grant_audit_outbox` tables/indexes, adapter/audit tests, and this record together. Because no protected runtime route consumes the table in this slice, rollback does not strand a browser contract. Once a runtime route begins issuing grants, rollback planning must account for in-flight one-time grants and retained audit evidence and must default to revoking grants rather than restoring broad URL credentials.

## Traceability

- #413 — replace full JWT query tokens with scoped ephemeral access grants.
- #506 — parent framework-neutral access-grant domain.
- #510 — this SQLite persistence and durable-audit slice.
- #433 — legacy database-object naming migration, explicitly not expanded here.

## References

Jones, M., & Hardt, D. (2012). *The OAuth 2.0 authorization framework: Bearer token usage* (RFC 6750). Internet Engineering Task Force. https://doi.org/10.17487/RFC6750

Lodderstedt, T., Bradley, J., Labunets, A., & Fett, D. (2025). *Best current practice for OAuth 2.0 security* (RFC 9700; BCP 240). Internet Engineering Task Force. https://doi.org/10.17487/RFC9700

SQLite Consortium. (n.d.). *Foreign key support*. SQLite. Retrieved August 16, 2026, from https://www.sqlite.org/foreignkeys.html

SQLite Consortium. (n.d.). *Isolation in SQLite*. SQLite. Retrieved August 16, 2026, from https://www.sqlite.org/isolation.html

SQLite Consortium. (n.d.). *Transaction*. SQLite. Retrieved August 16, 2026, from https://www.sqlite.org/lang_transaction.html
