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
- `createSqliteAccessGrantRepository(database)` persists hash-only grants, captures the mint-time `membership_id:token_version` snapshot, persists the matching immutable audit event, and consumes grants with one conditional `UPDATE` plus matching consume evidence under one savepoint.
- `createSqliteAccessGrantAuthorizationPort(database)` verifies project membership and, for `attachment_view`, the exact ready attachment before minting.
- `createSqliteAccessGrantMembershipPort(database)` returns the current opaque `membership_id:token_version` value that is rechecked inside the atomic consume statement.

The persisted `access_grants` relation is in third normal form for this bounded domain: one row represents one grant, non-key attributes describe only that grant, and user/project/attachment facts remain referenced by foreign keys rather than copied into repeated descriptive columns. `membership_version` is grant issuance state: it is the revocation epoch to which that credential was bound when it became durable, not a denormalized mutable membership attribute.

`access_grant_audit_outbox` is an immutable event relation: each row represents one security transition, and its subject/project/resource identifiers are event-time evidence rather than mutable resource attributes. It intentionally does not carry foreign keys to live resources because deleting a user, project, or attachment must revoke the usable grant without erasing historical access-control evidence.

### Owned database objects

- `access_grants`
- `access_grant_audit_outbox`
- `access_grant_audit_delivery_index`

`token_hash TEXT NOT NULL UNIQUE` deliberately relies on SQLite's constraint-owned unique index rather than creating a second explicit token-hash index. The adapter also does not create a forward-looking subject/resource index because no current query uses that access path. This avoids duplicate storage and write amplification while preserving the exact lookup uniqueness required by the repository. New explicit objects use descriptive multi-word snake_case names; SQLite-owned automatic indexes are implementation details rather than ScopeWeave-owned schema names. Existing legacy single-word objects are outside this slice and remain tracked separately by #433.

## Secret and lifecycle boundaries

The database stores `token_hash` but never the plaintext grant secret. Each usable-grant row binds the subject, project, purpose, audience, optional attachment, mint-time `membership_version`, issue/expiry timestamps, and use/revocation timestamps. `ON DELETE CASCADE` makes deletion of a subject, project, or bound attachment an immediate lifecycle revocation for dependent usable grants.

Audit-outbox rows store only the grant correlation ID and non-secret authorization/event facts. The plaintext secret and its hash are both absent from the outbox. Audit evidence deliberately survives lifecycle deletion of the underlying attachment or usable grant.

SQLite foreign-key enforcement is explicitly enabled by the existing data bootstrap. The adapter relies on SQLite's documented foreign-key action semantics for resource deletion and on its transactional isolation/serialized writes for one-winner state transitions.

## Atomic one-time consumption

The mint savepoint reads the current membership row identity and user `token_version` immediately before inserting the usable grant. If no active membership exists at that point, no grant row or mint audit event is committed. If membership state changes after this snapshot, the resulting grant can remain stored but cannot be redeemed against the new revocation epoch.

The consume operation is a single conditional `UPDATE access_grants SET used_at_ms = ? ...` statement. A row can move from unused to used only when all conditions hold together:

1. token hash matches;
2. purpose and audience match;
3. project and optional attachment binding match;
4. `used_at_ms` and `revoked_at_ms` are still null;
5. current time is strictly before expiry;
6. the current `membership_id:token_version` equals the grant's persisted mint-time `membership_version`; and
7. the same current version still matches live project membership and user `token_version` inside the conditional write.

Because the unused-state predicate, persisted mint snapshot, and live membership predicate participate in the same write statement, two concurrent consumers cannot both perform the unused→used transition, and a version change between mint and redemption cannot silently authorize the older credential. A membership removal/re-add changes the durable membership identity; logout-all/password-style session invalidation changes `token_version`. Either change makes an already minted but unused grant fail closed.

The consume `UPDATE` and the corresponding `consumed` audit-outbox insert execute under one SQLite savepoint. If durable audit evidence cannot be inserted, the savepoint rolls the consume transition back, leaving the grant unused and safely retryable after the durable boundary recovers. Mint uses the same pattern: the secret is not returned from a successful repository call unless the hash-only usable-grant row, mint-time membership snapshot, and `minted` audit evidence commit.

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

Project-only purposes such as `stream` require current project membership and carry no attachment binding. The repository repeats the membership lookup while persisting the grant so a membership loss after the authorization-port check cannot produce a redeemable credential.

## Failure evidence and root-cause correction

Exact-head Server Tests run `31894406313` checked out merge preview `d3ccc89ad32009cacd1275a661bc08b0e102c49e`, combining parent `28908e95ffa3c11676c99124fa1e95b49486098b` with child head `d638476c51966a5909557ee28ea730e7f3271d5b`. Its `unit-and-api` job `95035352256` failed the realistic regression `SQLite adapter atomically binds membership version to redemption`: incrementing `users.token_version` after mint did not invalidate the unconsumed grant.

The defect was causal rather than test infrastructure. The previous adapter obtained `membership_id:token_version` only during redemption and compared that newly read value with the same live database state. It never persisted the revocation epoch present when the grant was issued, so a version change between mint and redeem was invisible. The correction adds a mint-time `membership_version` snapshot and requires the current value to equal both that snapshot and live membership state in the one-time consume `UPDATE`. No check, protection rule, or assertion was weakened.

The existing failing regression is retained, renamed to make its mint-time invariant explicit, and the persistence test now directly asserts the stored snapshot (`100:0`) before redemption. Hosted exact-current-head evidence after the correction remains authoritative; queued, cancelled, predecessor-head, or merge-preview evidence for an older head is not promoted to passing.

A later current-head review identified two unnecessary explicit indexes on `access_grants`: one duplicated the implicit index already owned by `token_hash UNIQUE`, and one covered a subject/resource access path that the adapter never queries. Commit `340cf264...` added the realistic schema regression first. Server Tests run `33127984486`, job `98710585231`, failed RED on that regression and reported both explicit index names as the unexpected actual state. The production correction removed only those two explicit indexes while preserving the uniqueness constraint. The next run `33128070491`, job `98710864961`, then exposed a predecessor expectation in the schema-name test that still listed the deleted indexes; the test contract was aligned to the intentionally smaller owned-object set while the independent `PRAGMA index_list` regression remains responsible for proving that no redundant explicit indexes return.

## TDD evidence

The first two commits on the stacked branch were intentionally RED: `tests/unit/access-grant-sqlite.test.mjs` imported a not-yet-existing `server/access_grant_sqlite.mjs`, and the canonical test/coverage scripts were updated to execute that contract before production implementation existed. Hosted workflows for that predecessor head were cancelled after later branch movement; cancelled evidence is not promoted to passing.

The audit-durability hardening was also test-first. `tests/unit/access-grant-audit-outbox.test.mjs` first required a not-yet-existing outbox and transactional rollback semantics. The implementation then added the immutable outbox relation and savepoint-coupled mint/consume transitions; the pre-existing schema-name regression was updated only because the new compliant outbox/index became intentionally owned database objects.

The later exact-head Server Tests failure described above supplied a second RED regression for the revocation-epoch gap. The correction preserves that regression rather than replacing it with an assertion-only surrogate.

The redundant-index repair supplied another exact hosted RED. Its retained edge regression interrogates SQLite's own `PRAGMA index_list('access_grants')`, requires no explicitly created (`origin = 'c'`) index for the current table, and separately verifies that a uniqueness-constraint-owned (`origin = 'u'`) index still exists. This distinguishes performance cleanup from accidental loss of the security-critical token-hash uniqueness constraint.

Current tests cover:

- hash-only persistence and absence of a plaintext-secret column;
- persisted mint-time membership/version binding;
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
- absence of redundant or unused explicit `access_grants` indexes while token-hash uniqueness remains constraint-enforced;
- membership-port fail-closed behavior;
- schema lifetime constraints;
- mint and consume audit evidence with no plaintext secret;
- rollback of a mint when its durable audit insert fails;
- rollback of a consume when its durable audit insert fails, followed by successful retry after recovery;
- audit-evidence retention after attachment lifecycle deletion; and
- canonical `c8` registration for all adapter/audit behavior files and the production adapter.

A local Node 22 direct adapter probe on the earlier persistence implementation exercised schema installation, authorization, membership versioning, insert/find, successful conditional consume, and replay rejection. That probe predates the transactional-audit and mint-snapshot hardening and is not promoted to current-head evidence. Hosted exact-current-head CI remains authoritative for merge decisions.

## Migration, rollback, and compatibility

The schema is installed only after referenced core tables exist. Idempotent `CREATE TABLE IF NOT EXISTS` plus the audit-delivery `CREATE INDEX IF NOT EXISTS` make bootstrap safe for databases created by this unshipped slice. This active branch adds the `membership_version` column before any protected runtime route consumes `access_grants`; no protected `develop` release has shipped the earlier branch-only schema, so no customer migration is claimed or required by this slice. The eventual protected integration must ship this schema as one coherent versioned change and must not treat a locally persisted pre-integration development database as release evidence.

This slice adds no destructive migration and does not rename legacy objects. Rollback removes the adapter import/bootstrap call, `access_grants` and `access_grant_audit_outbox` tables plus the audit-delivery index, adapter/audit tests, and this record together. Because no protected runtime route consumes the table in this slice, rollback does not strand a browser contract. Once a runtime route begins issuing grants, rollback planning must account for in-flight one-time grants and retained audit evidence and must default to revoking grants rather than restoring broad URL credentials.

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