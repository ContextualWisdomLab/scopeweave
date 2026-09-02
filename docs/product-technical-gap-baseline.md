# ScopeWeave product and technical gap baseline

## Buyer outcome and product responsibility

ScopeWeave is the project-planning and WBS product boundary: teams create and
maintain project plans, collaborate under tenant-scoped access control, measure
schedule/cost progress, exchange planning artifacts, and retain enterprise audit
evidence. The repository owns the browser planner plus its SaaS API/persistence
implementation. Shared LLM policy remains delegated to
`ContextualWisdomLab/contextual-orchestrator`; Clearfolio document conversion is
an integration boundary rather than ScopeWeave-owned document rendering.

The current naming-repair priority is the **Audit Trail** persistence contract,
because compliance evidence is durable, tenant-scoped, security-sensitive, and
buyer-visible through audit/export APIs. A persistence rename therefore has
higher migration and compatibility risk than a local implementation-variable
rename.

## DDD context map and ubiquitous language

| Bounded context | Owned concepts | Important invariants |
| --- | --- | --- |
| Tenant and Access | workspace, membership, authenticated principal, access role | project/audit reads remain tenant scoped; owner/admin manage audit access |
| Project Planning | project plan, task hierarchy, revision, baseline, sprint | optimistic project versions remain linear; planning records stay within the owning workspace |
| Audit Trail | audit event, audit action, audit target, audit metadata | append-only evidence; every durable audit identifier is semantically specific; organization filtering is indexed |
| Integration | webhook delivery, attachment conversion, AI briefing | external/vendor schemas are translated at adapters and do not define internal ubiquitous language |

Audit Trail aggregate/repository language is `audit_event`, not generic
`record`/`item`/`event` in persistence code. The durable relation is
`audit_events`; its key is `audit_event_id`, business action is `audit_action`,
and structured detail is `audit_metadata_json`.

## Persistence model and migration boundary

Relevant ERD slice:

```text
users(user_id compatibility column today: id)
  1 ─────< audit_events.user_id (nullable, ON DELETE SET NULL)

orgs(org_id compatibility column today: id)
  1 ─────< audit_events.org_id (required, ON DELETE CASCADE)

 audit_events
 ├─ audit_event_id  PK
 ├─ org_id          FK
 ├─ user_id         FK nullable
 ├─ audit_action
 ├─ target_type
 ├─ target_id
 ├─ audit_metadata_json
 └─ created_at

 audit_events_org_event_idx(org_id, audit_event_id)
```

This PR intentionally repairs only the verified Audit Trail ownership slice; it
does not mechanically rename every legacy table in the repository. Historical
`audit_log(id, action, meta)` is accepted only as a startup migration source.
Migration uses `BEGIN IMMEDIATE`, refuses ambiguous column sets and dual
populated authorities, copies rows into `audit_events`, removes legacy audit
indexes/table atomically, and rolls back on failure. Foreign-key semantics and
3NF remain unchanged. Audit writes are append-only, so no UPSERT path changes.
The existing tenant hot path remains supported by
`audit_events_org_event_idx(org_id, audit_event_id)`; no partitioning or runtime
read/write split is introduced.

## Compatibility and naming-contract status

The established `/api/orgs/:id/audit` JSON payload, audit CSV, and workspace
export retain historical wire names such as `id`, `action`, and `meta`. Those
fields are compatibility surface names and are isolated at explicit SQL aliases
inside the HTTP/export adapter. Durable storage and production audit writes use
semantic multiword names directly. Tests reject leakage of
`audit_event_id`/`audit_action`/`audit_metadata_json` into the established HTTP
payload while also rejecting generic audit persistence columns.

Organization-wide naming is not declared complete for this repository. The
current repair is deliberately bounded to the audited high-leverage persistence
contract; other legacy persistence/API names require separate ownership and
migration evidence before change. Idiomatic multiword camelCase/PascalCase names
are not naming defects.

## Security, test, and operability baseline

- Protected development base inspected before the repair:
  `develop@2c328875e00e86537df3e965170be80532571cad`.
- Required repository contexts observed at that base included `unit-and-api`,
  `cloud-e2e`, JavaScript/TypeScript CodeQL, Python CodeQL, and `property fuzz`.
- The naming regression was introduced before production repair. Current unit
  coverage verifies fresh semantic storage, absence of persistent/runtime
  `audit_log`, realistic legacy data migration, row preservation, semantic index
  creation, and idempotent reopen.
- API smoke coverage verifies the historical audit wire fields remain present,
  semantic persistence names do not leak, and the CSV formula-injection fixture
  writes through the semantic durable relation.
- The source + consumer compatibility repair was present together by
  `59e1e19eb1ba363efc789368b2d2217b6794b61d`; subsequent commits update
  architecture/change/doctoring evidence on the same non-force history.
- Final merge evidence must come from the unchanged current PR head with all live
  required checks terminal-success and independent current approval. Base or
  predecessor checks are not transferable.

## Current gaps and next leverage order

1. Complete fresh exact-head verification and independent review for the Audit
   Trail migration before merge.
2. Continue persistence-first naming audit in ScopeWeave, prioritizing durable
   public/domain contracts over local variables. Each subsequent table or API
   slice requires its own bounded-context rationale, migration/compatibility
   plan, and executable consumer coverage.
3. After repository-local high-risk contracts are exhausted, return to shared
   cross-repository schemas/libraries before lower-scope implementation names.
