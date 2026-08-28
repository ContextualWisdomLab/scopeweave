# ScopeWeave Planner Design

## Goal
- Deliver a production-grade WBS planner as a static pure HTML/CSS/JavaScript web app with hierarchical editing, weighted progress calculations, CSV import/export, optional `wbs.json` file sync, and a Gantt overlay.

## Constraints
- No runtime libraries, frameworks, or CDNs.
- Must run on modern Chrome, Firefox, and Edge.
- Must preserve a single global `tasks` array and a single `renderAll()` rerender entrypoint.
- Must deploy cleanly to GitHub Pages.
- Browser-only static hosting cannot silently overwrite repository files on disk or on GitHub.

## Approaches

### 1. Flat table-only editor
- Pros: simplest implementation.
- Cons: weak hierarchy UX, poor match for 3-depth WBS and expand/collapse needs.

### 2. Tree-table SPA with derived metrics and modal Gantt (**recommended**)
- Pros: best fit for WBS editing, responsive control of 3 levels, straightforward CSV/export mapping, manageable in one JS file while honoring `tasks` + `renderAll()`.
- Cons: more DOM work and careful drag/drop logic required.

### 3. Dual-pane spreadsheet plus chart canvas
- Pros: richer gantt visualization.
- Cons: heavier complexity, harder accessibility, unnecessary for v1.

## Recommended architecture
- `index.html` defines the metadata toolbar, responsive tree-table, footer action bar, hidden file inputs, and Gantt modal.
- `styles.css` provides white-based enterprise styling, depth/zebra states, responsive column hiding, and chart colors.
- `app.js` owns:
  - `tasks` and UI state
  - seed loading
  - validation
  - computed fields and cumulative summaries
  - inline edit/create/delete/expand-collapse
  - HTML5 drag-and-drop within same depth
  - CSV import/export
  - local autosave and optional `wbs.json` file-handle autosave
  - Gantt modal rendering

## Data model decisions
- Canonical records stay flat and include stable `id`, `parentId`, and `depth` to support same-level reordering.
- JSON import/export follows the requested array shape and preserves the `plannedEndDdate` property name for compatibility.
- Derived columns are not persisted in `wbs.json`; they are recalculated on every `renderAll()`.
- The global metadata state includes project name and base date; totals are recomputed from current tasks.

## Persistence decision
- `wbs.json` in the repository is treated as the initial seed and export format.
- Every data mutation autosaves immediately to `localStorage`.
- On a first visit with only seed data, the UI labels the sample explicitly and
  provides a dismissible notice or a confirmed clear-to-empty-plan action.
- The onboarding dismissal marker is stored separately from the planner payload
  so the existing seed/autosave contract remains unchanged.
- On browsers supporting File System Access API, the user can grant a writable handle for `wbs.json`; after that, each change also writes the JSON array to the chosen file automatically.
- Where that API is unavailable, the app remains functional and exposes explicit JSON/CSV export paths; this is the safest achievable static-hosting behavior.

## Validation rules
- Date fields accept only `YYYY-MM-DD`.
- Planned end date must be on or after planned start date.
- Actual end date must be on or after actual start date.
- Invalid date ordering shows red warning text inline.
- Progress status, actual progress percentage, weighted metrics, total days, and cumulative rates are recalculated automatically.

## Testing strategy
- Manual browser verification for all acceptance-relevant UI points.
- Playwright E2E coverage for seed rendering, add/edit/delete, drag/drop reorder, persistence restore, CSV round-trip, and Gantt modal visibility.
- Fresh local static-server checks before completion.

## Deployment strategy
- Publish static files via GitHub Pages from the repository default branch.
- Keep asset URLs relative.
- Include `404.html` mirroring the entry page for Pages resilience.

## Explicit decisions
- Use a tree-table instead of a spreadsheet clone.
- Limit depth to exactly 3 levels using phase/activity/task semantics.
- Use optional file-handle sync to honor the `wbs.json` autosave requirement as closely as static browsers allow.
- Keep runtime single-page and build-free.
