# ScopeWeave Planner

Production-grade pure HTML/CSS/JavaScript WBS planner with tree editing,
cumulative progress metrics, CSV import/export, `wbs.json` autosave sync,
and a weekly Gantt overlay.

## Features

- Pure static runtime: HTML, CSS, JavaScript only
- 3-level WBS hierarchy (`단계 > Activity > Task`) with expand/collapse
- Inline add/edit/delete, row-click edit, and same-level drag-and-drop
  subtree reorder
- Automatic day, weight, planned progress, actual progress, and weighted
  progress calculations
- CSV import/export using the screen column contract
- Local autosave with optional File System Access API sync to `wbs.json`
- Weekly Gantt modal with planned (`#333333`) and actual (`#34cb03`)
  overlays
- Responsive column reduction for screens under 800px

## Repository contract

- Runtime stays static-host compatible for GitHub Pages.
- Runtime dependencies are forbidden; CI/dev-only automation under
  `.github/`, `scripts/`, `tests/`, and `docs/` is allowed.
- OpenCode Review, Strix Security Scan, and PR Review Merge Scheduler are
  inherited from the organization-level required workflows in
  `ContextualWisdomLab/.github`, not copied into this repository.

## Local development

```bash
npm install
python3 -m http.server 4173
```

Open `http://127.0.0.1:4173`.

## Verification

```bash
npm run test:e2e
python3 -m pytest tests/config
```

## Persistence model

- Every mutation is autosaved into `localStorage` immediately.
- `wbs.json` at the repo root acts as the seed file for static hosting.
- Browsers that support File System Access API can connect a writable
  `wbs.json` file for automatic JSON sync on every change.
- Synthetic hierarchy wrapper rows generated from imported flat records
  are excluded from external `wbs.json` sync so the saved JSON remains
  in the user-facing schema.

## Security workflow

- Organization required workflows provide OpenCode Review, Strix Security
  Scan, PR Review Merge Scheduler, failed-check explanation, and coverage
  evidence.
- Repository-local workflows remain for ScopeWeave-specific static delivery
  and companion SCA lanes, including dependency review, OSV, Trivy,
  Scorecard, and Pages.
- Kubernetes/IaC coverage is documented as follow-up work; this static repo
  intentionally does not add deployment manifests just to satisfy security
  tooling.

See `docs/user-guide.md` for operator guidance.
