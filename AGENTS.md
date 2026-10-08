# AGENTS.md

## Project overview

- ScopeWeave Planner is a pure HTML/CSS/JavaScript WBS planning web app.
- Runtime dependencies are forbidden; development-only tooling is allowed.

## Defaults

- Keep the runtime static-host compatible for GitHub Pages.
- Preserve the single global `tasks` array as the source of truth.
- Use a single `renderAll()` integration path for user-visible rerenders.
- Prefer browser-native APIs only.

## Verification

- Serve locally with `python3 -m http.server 4173`.
- Run end-to-end verification with `npm run test:e2e`.
- Run Strix helper self-tests with `bash scripts/ci/test_strix_quick_gate.sh`.
- Run Strix source-regression tests with `python3 -m pytest
  tests/config/test_strix_batch_size_source.py
  tests/config/test_strix_deleted_file_scope_source.py
  tests/config/test_strix_static_repo_adaptations.py`.

## CI / security workflow notes

- Keep Strix and companion SCA workflows development-only; do not add runtime dependencies.
- Treat Strix as a repository scan target for this static app, not as
  a Kubernetes deployment blocker.
- Keep workflow and `scripts/ci/` changes inside the Strix PR-scan
  scope; do not reintroduce exclusions that would skip CI/security
  automation changes.
- If GitHub CLI output emits Projects(classic) deprecation warnings,
  prefer `gh api` or explicit `--json` field selection over default
  human-formatted `gh issue view` / `gh pr view` output.
