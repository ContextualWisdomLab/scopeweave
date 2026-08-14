# Schema migration ledger and fail-closed generation guard

## Decision

Issue #433 requires the existing single-word SQLite object names to move to the
repository's two-or-more-word `snake_case` contract without serving a database
that is half old-schema and half canonical-schema. The first bounded
expand/verify slice introduces an append-only `schema_migrations` ledger and a
framework-independent generation classifier before any destructive rename is
attempted.

The guard recognizes exactly two complete generations for the ten tables in the
rename plan:

- legacy: `users`, `orgs`, `memberships`, `projects`, `invites`, `webhooks`,
  `baselines`, `comments`, `sprints`, `attachments`;
- canonical: `user_accounts`, `organization_records`,
  `organization_memberships`, `project_records`, `invitation_records`,
  `webhook_endpoints`, `project_baselines`, `project_comments`,
  `project_sprints`, `project_attachments`.

Other already-compliant ScopeWeave tables do not determine the migration
generation. Any missing table, old/new mixture, or duplicated generation is an
invalid startup state and raises `SchemaMigrationStateError` before request
handling begins.

## Pre-bootstrap boundary

The database catalog is inspected **before** the legacy `CREATE TABLE IF NOT
EXISTS` and additive `ALTER TABLE` statements run. Only a genuinely empty
database may initialize the legacy schema from scratch. An existing database
must already be one complete known generation; mixed, incomplete, ledger-only,
or otherwise ambiguous states fail closed before legacy bootstrap can mutate
them.

A complete canonical generation is deliberately identified and recorded, but
this application version still uses legacy table names in its query layer.
Therefore startup records/verifies `canonical_schema_v2` and then fails with a
stable "canonical schema generation is not yet supported by this application
version" error. It does **not** recreate legacy tables over the canonical
schema. Serving a canonical database becomes valid only in the later issue #433
slice that migrates the application query/data-access layer as part of the same
reviewed cutover.

## Ledger contract

`schema_migrations` contains a stable `migration_key`, a low-cardinality
`state_code`, and an application timestamp. Repeated startup is idempotent via
`INSERT OR IGNORE`. Every persisted row must be one of the known exact
migration-key/state pairs before the current generation is recorded. Unknown
keys or corrupted state codes fail closed rather than being treated as harmless
history.

The ledger is monotonic across the naming migration. A canonical database may
retain the earlier `legacy_schema_v1` record and append `canonical_schema_v2`.
The reverse is forbidden: if the schema catalog is legacy while the ledger says
`canonical_schema_v2` has ever been reached, startup fails because that state is
consistent with an unsupported reverse migration, stale restore, or incomplete
recovery. Backup restoration must restore schema and migration history to one
coherent point rather than silently moving the schema backward under newer
ledger evidence.

After insertion, the persisted state is read back and compared with the fresh
schema-catalog classification so a corrupted current-generation record cannot
silently bless the database.

This slice deliberately does **not** rename application tables, create legacy
compatibility views, or claim PostgreSQL adapter readiness. Those operations
remain subsequent issue #433 work and must use the ledger/guard as the
precondition for an atomic expand/verify/contract cutover.

## Failure and recovery boundary

A partially renamed database is not automatically repaired on startup. Serving
mixed names would make query routing ambiguous and could split reads and writes
between generations. The process therefore fails closed. Operators must restore
a verified backup or complete the reviewed migration before restarting.

The later rename executor must run with foreign keys enabled, modern SQLite
rename propagation semantics, pre/post `PRAGMA integrity_check` and
`PRAGMA foreign_key_check`, deterministic interruption tests, restart evidence,
and a restore rehearsal. Reverse renames are not a substitute for backup
recovery, and a restore that moves from canonical history back to legacy schema
must restore the ledger from the same verified recovery point.

## Verification

`tests/unit/schema-migration-state.test.mjs` covers:

- idempotent legacy ledger creation;
- a distinct canonical-generation ledger record;
- preservation of valid legacy history when the canonical record is appended;
- rejection of unknown or corrupted migration-ledger identities/states;
- rejection of a canonical ledger record paired with a legacy schema generation;
- fail-closed mixed-generation detection;
- incomplete schema rejection;
- the complete ten-object legacy and canonical inventories;
- pre-bootstrap classification of pristine, legacy, canonical, and invalid
  databases; and
- a real `server/db.mjs` subprocess regression proving canonical startup fails
  for the truthful query-layer reason without recreating any legacy table.

The production module is registered in the Istanbul coverage command. The API
and existing server tests exercise normal startup integration through
`server/db.mjs`, while the canonical-database subprocess exercises the opposite
fail-closed boundary against a persisted SQLite file.

## Rollback

Before any table rename ships, rollback of this slice is non-destructive: revert
the startup guard and module. The extra `schema_migrations` table is inert data
and may remain in an existing database. Once a future rename migration is
released, rollback must follow that migration's backup/restore runbook instead
of deleting ledger history.

## References

International Organization for Standardization. (2023). *Information
technology—Database languages SQL—Part 1: Framework (SQL/Framework)*
(ISO/IEC Standard No. 9075-1:2023).
https://www.iso.org/standard/76583.html

SQLite Consortium. (2026). *ALTER TABLE*.
https://sqlite.org/lang_altertable.html

SQLite Consortium. (2026). *PRAGMA statements*.
https://sqlite.org/pragma.html
