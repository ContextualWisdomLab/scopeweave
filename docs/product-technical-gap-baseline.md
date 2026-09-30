# Product technical gap baseline

Status: Proposed
Predecessor pull request: #762
Predecessor exact head reviewed: `1d98a981bbb7d5f3b7753a1a4668898989d32ecf`
Successor branch: `codex/design-assurance-scopeweave-762-20260930`

## Goal and ownership

This successor preserves the complete valid accessibility delta from #762 after concurrent commits removed its product fix, contract test, and evidence baseline. ScopeWeave remains the canonical writer for its planner UI and domain state.

## Context and acceptance matrix

| Capability | Current evidence | Status | Required action |
| --- | --- | --- | --- |
| Semantic descriptions | DOM descriptions connected with `aria-describedby`; generic `role="note"` removed | GREEN (source contract) | Keep exact-head E2E green |
| Keyboard visibility | Description revealed by `:focus-visible` | GREEN (source contract) | Verify in a real browser |
| Pointer/touch and responsive layouts | No current-head desktop/mobile/intermediate screenshots | FAIL | Capture pointer/touch evidence at three viewports |
| WCAG 2.2 AA and assistive technology | Automated contract added; screen-reader evidence absent | FAIL | Run axe and keyboard/screen-reader audit |
| UI states and recovery | Existing planner states are outside this focused delta | NOT REVALIDATED | Exercise loading/empty/error/offline/permission/read-only/stale/conflict/retry/busy where applicable |
| Locales | Product currently exposes Korean copy; ko/en/ja/zh/vi/es/de/fr evidence absent | FAIL | Add versioned translation authority and locale E2E |
| Determinism and exact values | Summary values remain owned by existing domain logic | NOT AFFECTED | Preserve exact-value contract |
| Large data, import/export, persistence/reload | No behavior changed by this delta | NOT REVALIDATED | Run current-head large-data and recovery suite |

## Merge gate

Keep this PR Draft until exact-head Checks, current-head browser interaction, responsive screenshots, accessibility evidence, and required review are green. The predecessor remains open; no delta is discarded or represented as complete.
