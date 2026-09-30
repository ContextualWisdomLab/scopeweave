# Product technical gap baseline

Status: Proposed
Predecessor pull request: #762
Predecessor exact head reviewed: `1d98a981bbb7d5f3b7753a1a4668898989d32ecf`
Successor branch: `codex/design-assurance-scopeweave-762-20260930`
E2E RED evidence head: `eb8780663e4763776de6affebb8d0860a96850c3`
E2E contract repair head: `4315f838411e9e4e6f9c70febf0bc8bdf1f83821`

## Goal and ownership

This successor preserves the complete valid accessibility delta from #762 after concurrent commits removed its product fix, contract test, and evidence baseline. Exact-head Server Tests run `36685203778` then showed that Playwright's `toBeVisible()` does not model CSS clipping: the 1×1 clipped description was correctly present for assistive technology but the matcher still classified its non-empty box as visible. The contract now asserts the actual clipped CSS before focus and the static, unclipped, visible state after focus. ScopeWeave remains the canonical writer for its planner UI and domain state.

## Context and acceptance matrix

| Capability | Current evidence | Status | Required action |
| --- | --- | --- | --- |
| Semantic descriptions | DOM descriptions connected with `aria-describedby`; generic `role="note"` removed | GREEN (source contract) | Keep exact-head E2E green |
| Keyboard visibility | RED run proved the generic visibility matcher was invalid; the contract now asserts clipped pre-focus CSS and unclipped visible focus state | REPAIR COMMITTED; NEW CHECKS REQUIRED | Verify in a real browser |
| Pointer/touch and responsive layouts | No current-head desktop/mobile/intermediate screenshots | FAIL | Capture pointer/touch evidence at three viewports |
| WCAG 2.2 AA and assistive technology | Automated contract added; screen-reader evidence absent | FAIL | Run axe and keyboard/screen-reader audit |
| UI states and recovery | Existing planner states are outside this focused delta | NOT REVALIDATED | Exercise loading/empty/error/offline/permission/read-only/stale/conflict/retry/busy where applicable |
| Locales | Product currently exposes Korean copy; ko/en/ja/zh/vi/es/de/fr evidence absent | FAIL | Add versioned translation authority and locale E2E |
| Determinism and exact values | Summary values remain owned by existing domain logic | NOT AFFECTED | Preserve exact-value contract |
| Large data, import/export, persistence/reload | No behavior changed by this delta | NOT REVALIDATED | Run current-head large-data and recovery suite |

## Merge gate

Keep this PR Draft until exact-head Checks, current-head browser interaction, responsive screenshots, accessibility evidence, and required review are green. The predecessor remains open; no delta is discarded or represented as complete.
