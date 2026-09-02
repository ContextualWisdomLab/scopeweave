# Audit Trail persistence semantic naming

## Decision

ScopeWeave owns the Audit Trail persistence vocabulary. Durable SQLite names
therefore describe the bounded-context meaning rather than relying on generic
single-word identifiers.

| Legacy durable name | Semantic durable name |
| --- | --- |
| `audit_log` | `audit_events` |
| `id` | `audit_event_id` |
| `action` | `audit_action` |
| `meta` | `audit_metadata_json` |
| `idx_audit_org` | `audit_events_org_event_idx` |

The existing `/api/orgs/:id/audit` JSON contract, audit CSV columns, and
workspace-export audit records predate this persistence repair. Their historical
`id`, `action`, and `meta` fields remain compatibility surface names and are
produced only by explicit SQL aliases in `server/app.mjs`. Internal writes and
reads use `audit_events`, `audit_event_id`, `audit_action`, and
`audit_metadata_json` directly. No persistent compatibility view is retained.

## Bounded-context rationale

The Audit Trail is append-only compliance evidence scoped to an organization.
`audit_event_id` identifies one recorded audit event, `audit_action` records the
business/security action, and `audit_metadata_json` stores action-specific
structured metadata. `audit_events_org_event_idx(org_id, audit_event_id)` names
and serves the tenant-scoped reverse-event query used by the audit endpoint.
These terms are part of the Audit Trail ubiquitous language rather than generic
storage vocabulary.

## Migration and rollback safety

Startup creates the semantic `audit_events` authority, then inspects a historical
`main.audit_log` only as a legacy migration source. Migration:

1. verifies `audit_log` is a table and that its column set is either the original
   `id/action/meta` shape or the short-lived semantic-column intermediate shape;
2. fails closed on mixed/ambiguous columns or when both old and new authorities
   already contain data;
3. starts `BEGIN IMMEDIATE`, copies rows to `audit_events`, removes legacy audit
   indexes and the legacy table, and commits as one transaction; and
4. rolls back the transaction and propagates the causal failure if any copy or
   DDL operation fails.

The new relation preserves the existing `org_id` and nullable `user_id` foreign
keys, one-row-per-audit-event 3NF shape, and append-only behavior. There is no
Audit Trail UPSERT path. The migration adds no partitioning and no read/write
split; its stronger write lock exists only during startup migration. The hot
runtime read remains tenant-scoped by `(org_id, audit_event_id)`.

## Executable evidence

The repair branch was cut from protected
`develop@2c328875e00e86537df3e965170be80532571cad`. TDD introduced
`tests/unit/audit-log-database-naming.test.mjs` before the production repair.
The current test contract covers fresh semantic storage, absence of durable or
temporary `audit_log`, data-preserving migration from a realistic legacy store,
semantic index creation, and idempotent reopen without duplicate audit events.
`tests/api/smoke.mjs` additionally proves that the established HTTP
`id/action/meta` fields remain present while internal semantic persistence field
names do not leak to the wire contract. Source and compatibility repairs were
present together by `59e1e19eb1ba363efc789368b2d2217b6794b61d`; documentation
commits follow on the same ordinary, non-force PR history.

Fresh required GitHub verification must attach to the final unchanged PR head;
predecessor, base, or model-only evidence is not a merge signal.
