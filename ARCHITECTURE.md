# ARCHITECTURE.md

## Runtime structure

- `index.html`: app shell and modal structure.
- `styles.css`: responsive layout, table, badges, gantt, and modal
  presentation. `.toast.show` is the standalone producer state.
- `toast-state.css`: cloud overlay `.toast.visible` rendering so SaaS
  status messages stay visually observable.
- `app.js`: state, rendering, editing, validation, persistence,
  import/export, and Gantt logic.
- `analytics.js`: EVM, S-curve, CPM, workload, cost, and requirements/RFI/RFP
  WBS-estimation readiness analysis.
- `wbs.json`: seed data in the user-specified JSON array format.

## SaaS bounded contexts and persistence

- **Tenant and Access** owns workspaces, memberships, authentication, and RBAC.
- **Project Planning** owns projects, revisions, baselines, comments, sprints,
  attachments, shares, and schedule-control state.
- **Audit Trail** owns append-only enterprise compliance evidence. Its durable
  SQLite relation is `audit_events`, with semantic persistence vocabulary such
  as `audit_event_id`, `audit_action`, and `audit_metadata_json`; the principal
  tenant query index is `audit_events_org_event_idx` on
  `(org_id, audit_event_id)`.
- **Integration** owns webhooks, Clearfolio attachment conversion, and
  contextual-orchestrator briefing boundaries.

The Audit Trail HTTP/CSV/export compatibility surface predates the persistence
rename and continues to expose wire fields such as `id`, `action`, and `meta`.
Those generic external names are isolated in explicit SQL aliases at the web
adapter boundary. Production writes and durable reads use the semantic
`audit_events` vocabulary directly.

Startup migration treats a historical durable `audit_log` table as a legacy
compatibility source only. The migration creates the semantic authority first,
validates that legacy and semantic column sets are not ambiguous, refuses to
merge two populated authorities, copies legacy rows under `BEGIN IMMEDIATE`,
drops the old table/indexes in the same transaction, and rolls back on failure.
The relation remains append-only and normalized as one audit event per row;
foreign-key semantics, the org-scoped hot read path, UPSERT behavior (none),
and runtime read/write topology are otherwise unchanged.

## CI and security structure

- `.github/workflows/pages.yml`: GitHub Pages deployment workflow for the
  static app.
- OpenCode Review, Strix Security Scan, and PR Review Merge Scheduler:
  organization-level required workflows from `ContextualWisdomLab/.github`.
- `.github/workflows/dependency-review.yml`: authoritative manifest-diff
  review workflow for repository dependency changes.
- `.github/workflows/osvscanner.yml`: authoritative OSV/SARIF workflow
  for dependency scanning.
- `tests/e2e/scopeweave.spec.js`: Playwright coverage for the user-facing
  app flows.
- `tests/config/`: repository governance and workflow ownership checks.

## Core decisions

- One global `tasks` array holds canonical task records.
- `renderAll()` owns all UI updates.
- Browser persistence uses `localStorage` for guaranteed autosave and
  optional File System Access API sync for `wbs.json` where supported.
- Static hosting treats repository `wbs.json` as seed data;
  export/manual save remains the portability path.
- Imported flat JSON may synthesize hierarchy wrapper nodes internally,
  but external `wbs.json` sync strips synthetic rows so the saved array
  stays in the requested user schema.
- Same-level drag-and-drop moves the whole subtree block, not a single
  row, to preserve tree-table integrity.
- Central Strix scans the repository surface without implying Kubernetes
  deployment ownership or blocking on absent IaC that this repo does not
  contain.
- Kubernetes/IaC security coverage remains a follow-up design lane for
  any future `infra/` or container packaging surface.
