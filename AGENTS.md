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
- Run end-to-end verification with `pnpm run test:e2e`.
- Run workflow ownership checks with `python3 -m pytest tests/config`.

## CI / security workflow notes

- OpenCode Review, Strix Security Scan, and PR Review Merge Scheduler are
  organization-level required workflows from `ContextualWisdomLab/.github`.
  Do not copy them into this repository.
- Keep companion SCA workflows development-only; do not add runtime
  dependencies.
- If GitHub CLI output emits Projects(classic) deprecation warnings,
  prefer `gh api` or explicit `--json` field selection over default
  human-formatted `gh issue view` / `gh pr view` output.

<!-- BEGIN cwl-agent-guidance -->
## Agent guidance (CWL governance)

Cross-agent conventions for any agent working in this repo (Claude, Codex,
Cursor, opencode, ...). Distilled from ContextualWisdomLab governance.

### Security & review gate

- Every PR runs a central **Security Scan** required gate: `osv-scan` +
  `dependency-review` (diff-scoped) and `trivy-fs` (repo-wide, CRITICAL/HIGH,
  fixable only). It runs against every PR base, **including stacked PRs**.
- A failing `trivy-fs` is a **REAL finding, not a flake.** Read the job log and
  the uploaded SARIF/code-scanning results to identify each rule id, severity,
  file, and line before changing code. SARIF-mode Trivy logs may only show the
  scanner configuration and exit code, so use code scanning or the SARIF
  artifact when the log does not enumerate findings. Then **remediate**: bump
  the offending dependency, fix the misconfig in
  `Dockerfile` or `infra/k8s/*.yaml`, or add a narrow, documented
  `.trivyignore` (`.trivyignore.yaml`) entry only for a genuine false positive.
  Never weaken, skip, or disable the gate.
- A local scan with a stale DB misses findings. Run
  `trivy --download-db-only` first, then scan the **merge ref**, not just the PR
  head, e.g. `trivy fs --severity CRITICAL,HIGH --ignore-unfixed .`.
- Worked example from the historical PR queue: the misconfig scan flagged
  **KSV-0020 / KSV-0021** (UID/GID `<= 10000` — `infra/k8s/deployment.yaml`
  uses `runAsUser/runAsGroup: 101`), **KSV-0110** (no explicit `namespace`, so
  the manifests land in `default`), and **DS-0026** (no `HEALTHCHECK` in the
  `Dockerfile`). Fix these in-tree; do not ignore them.
- The org `code_scanning` ruleset is intentionally **CodeQL-only** (multiple
  code-scanning tools cannot converge on one PR ref). Gating is by the Security
  Scan **job result**, not the `code_scanning` rule — do not add tools to that
  rule.

### Code exploration

- Initialize and sync CodeGraph before review or edits, then keep it current
  after rebases and source changes. Use CodeGraph (`codegraph status`,
  `codegraph sync`, `codegraph explore "<query>"`, or the code-review-graph MCP
  tools) as the first structural map, with ripgrep/find as a fast companion for
  exact text search.
<!-- END cwl-agent-guidance -->
