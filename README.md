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
- Strix security scanning is imported as a repository scan workflow,
  not as a runtime blocker entity.

## Local development

```bash
npm install
python3 -m http.server 4173
```

Open `http://127.0.0.1:4173`.

## Verification

```bash
npm run test:e2e
bash scripts/ci/test_strix_quick_gate.sh
python3 -m pytest \
  tests/config/test_strix_batch_size_source.py \
  tests/config/test_strix_deleted_file_scope_source.py \
  tests/config/test_strix_static_repo_adaptations.py
```

## Persistence model

- Every mutation is autosaved into `localStorage` immediately.
- `wbs.json` at the repo root acts as the seed file for static hosting.
- Browsers that support File System Access API can connect a writable
  `wbs.json` file for automatic JSON sync on every change.
- Synthetic hierarchy wrapper rows generated from imported flat records
  are excluded from external `wbs.json` sync so the saved JSON remains
  in the user-facing schema.

## Strix security workflow

- `.github/workflows/strix.yml` runs the upstream-derived Strix quick
  scan against the repository root (`./`).
- Pull requests without `STRIX_LLM` and `LLM_API_KEY` skip cleanly;
  `push`/`schedule` runs fail closed if those required secrets are
  missing.
- If the configured Strix model resolves to Vertex AI and `GCP_SA_KEY`
  is absent, pull requests now skip cleanly while `push`/`schedule`
  continue to fail closed.
- CI-only Python dependencies are pinned in `requirements-strix-ci.txt`
  so companion supply-chain workflows can review the same dependency
  surface that Strix installs.
- Companion workflows `.github/workflows/dependency-review.yml` and
  `.github/workflows/osvscanner.yml` provide the authoritative
  manifest-only verification lane that the Strix gate expects.
- The dependency-review lane no-ops successfully until repository-level
  dependency graph support is enabled, instead of failing every PR on a
  settings-only prerequisite.
- Workflow and `scripts/ci/` changes remain inside the Strix scannable
  PR scope for this repo; they are not silently skipped.
- Kubernetes/IaC coverage is documented as follow-up work; this static
  repo intentionally does not add deployment manifests just to satisfy
  Strix.

See `docs/user-guide.md` for operator guidance and
`docs/operations/strix-workflow.md` for workflow behavior, secrets,
artifacts, and adaptation notes.
