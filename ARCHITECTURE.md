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

## CI and security structure

- `.github/workflows/pages.yml`: GitHub Pages deployment workflow for the
  static app.
- `.github/workflows/server-tests.yml` and `.github/workflows/fuzz.yml`:
  repository-owned product/runtime validation.
- OpenCode Review, Strix Security Scan, PR Review Merge Scheduler, CodeQL,
  Dependency Review, OSV, and the broader Security Scan are organization-level
  required workflows owned by `ContextualWisdomLab/.github`; ScopeWeave does not
  carry repository-local copies of those central lanes.
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