# Product technical gap baseline

Status: Proposed
Predecessor pull request: #762
Predecessor exact head reviewed: `1d98a981bbb7d5f3b7753a1a4668898989d32ecf`
Successor branch: `codex/design-assurance-scopeweave-762-20260930`
E2E RED evidence head: `eb8780663e4763776de6affebb8d0860a96850c3`
E2E contract repair head: `4315f838411e9e4e6f9c70febf0bc8bdf1f83821`
Security evidence head: `0ef770808312d134d372e59d35ffdda15270dbd6`

## Goal and ownership

This successor preserves the complete valid accessibility delta from #762 after concurrent commits removed its product fix, contract test, and evidence baseline. Exact-head Server Tests run `36685203778` showed that Playwright's `toBeVisible()` does not model CSS clipping: the 1×1 clipped description was correctly present for assistive technology but the matcher still classified its non-empty box as visible. The contract now asserts the actual clipped CSS before focus and the static, unclipped, visible state after focus. ScopeWeave remains the canonical writer for its planner UI and domain state.

Shared Hono dependency repair remains separately owned by Draft PR #687 at `b5da0a539c46fb4600d2c492a459e937cbc22b98`. Consumer PR #771 must inherit it through ordinary integration and non-force reconciliation rather than copy its lockfile delta.

## Exact-head evidence

At `0ef770808312d134d372e59d35ffdda15270dbd6`, Server Tests run `36726131003`, Fuzz `36726131234`, and SAST Semgrep `36726131614` are terminal success. Security run `36726131157`, Trivy job `109932978980`, checked out the exact head and failed on CVE-2026-84363, CVE-2026-84364, and CVE-2026-84365 in protected-base Hono 4.13.0. Canonical owner #687 upgrades Hono to 4.13.7 and has GREEN Security/Server Tests/Fuzz/Semgrep evidence, but its CodeQL run `34423378793` remains failure. CodeQL PR on #771 is skipped. Therefore neither owner nor consumer is merge-ready.

## Context and acceptance matrix

| Capability | Current evidence | Status | Required action |
| --- | --- | --- | --- |
| Semantic descriptions | DOM descriptions connected with `aria-describedby`; generic `role="note"` removed | GREEN — hosted Server Tests | Preserve on the eventual reconciled head |
| Keyboard visibility | Hosted browser contract verifies clipped pre-focus CSS and unclipped visible focus state | GREEN — hosted Server Tests | Add independent real-browser/AT evidence |
| Dependency security | Exact-head Trivy reproduced three Hono 4.13.0 CVEs; #687 owns the 4.13.7 repair | FAIL — OWNER ROUTED | Clear #687 governance, integrate normally, non-force reconcile #771, rerun all checks |
| Pointer/touch and responsive layouts | No current-head desktop/mobile/intermediate screenshots | FAIL | Capture pointer/touch evidence at three viewports |
| WCAG 2.2 AA and assistive technology | Automated contract passes; screen-reader evidence absent | FAIL | Run axe and keyboard/screen-reader audit |
| UI states and recovery | Existing planner states are outside this focused delta | NOT REVALIDATED | Exercise loading/empty/error/offline/permission/read-only/stale/conflict/retry/busy where applicable |
| Locales | Product currently exposes Korean copy; ko/en/ja/zh/vi/es/de/fr evidence absent | FAIL | Add versioned translation authority and locale E2E |
| Determinism and exact values | Summary values remain owned by existing domain logic | NOT AFFECTED | Preserve exact-value contract |
| Large data, import/export, persistence/reload | No behavior changed by this delta | NOT REVALIDATED | Run current-head large-data and recovery suite |

## Merge gate

Keep this PR Draft until #687 is integrated and #771 is non-force reconciled, all exact-head Checks and required review are terminal GREEN, and current-head browser interaction, responsive screenshots, accessibility and locale evidence are complete. The predecessor remains open; no delta is discarded or represented as complete.
