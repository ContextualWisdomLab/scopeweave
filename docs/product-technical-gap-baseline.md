# Product technical gap baseline

Status: Proposed
Pull request: #704
Base reviewed: `develop@2c328875e00e86537df3e965170be80532571cad`
RED head: `0ecc782527bd7f4ef93ceece4c32be99425364f7`
Product repair head: `6beda081ab7484481e72ad6eef24628a4acdc318`

## Goal and boundary

ScopeWeave owns its planner editor, validation presentation, task-domain mutation, and persistence. This change keeps an invalid Save action discoverable without allowing presentation state to replace domain validation: `saveEditor()` still recomputes the domain-facing validation result and refuses invalid mutation.

## Root cause

The branch had converged to the protected-base tree while its PR body still claimed a focusable `aria-disabled` control. Production used native `disabled`, omitted `novalidate`, and offered no activation feedback. The Playwright suite still asserted the obsolete native-disabled behavior.

## Exact-head acceptance matrix

| Capability | Current evidence | Status | Required action |
| --- | --- | --- | --- |
| Deterministic validation | Submit handler flushes validation and `saveEditor()` revalidates before mutation | GREEN (source contract) | Keep full E2E green |
| Semantics | Save remains native button and carries `aria-disabled` only while invalid | GREEN (source contract) | Verify accessibility tree |
| Keyboard/pointer/touch | Playwright contract requires enabled focusable control, activation feedback, retained editor | TEST ADDED; NOT EXECUTED HERE | Run exact-head Chromium plus touch browser |
| Error/retry/focus | Existing field errors remain connected; invalid activation announces next action | PARTIAL | Verify focus order and retry after correcting fields |
| Responsive evidence | No current-head desktop/mobile/intermediate screenshots | FAIL | Capture all three viewport classes |
| WCAG 2.2 AA/reduced motion | Source semantics improved; real AT/contrast/motion audit absent | FAIL | Run axe and screen-reader/keyboard audit |
| Locales | UI remains Korean-only for this message; ko/en/ja/zh/vi/es/de/fr evidence absent | FAIL | Move copy to versioned translation resources and run locale E2E |
| Persistence/reload/rollback/race | Invalid path does not call mutation, but reload and concurrent editing evidence absent | FAIL | Exercise reload, stale/conflict, retry, and cleanup |
| Large data/import/export/recovery | Not changed by this focused editor fix | NOT REVALIDATED | Run current-head performance and recovery suites |

## Merge gate

Keep Draft until exact-head Checks, required review, real-browser interaction, responsive screenshots, WCAG evidence, all eight locales, and applicable persistence/recovery evidence are green. Queued, skipped, or predecessor-head runs are not acceptance.
