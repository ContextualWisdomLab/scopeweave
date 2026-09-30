# Product technical gap baseline

Status: Proposed
Pull request: #772 (verified successor of #704)
Base reviewed: `develop@2c328875e00e86537df3e965170be80532571cad`
RED head: `0ecc782527bd7f4ef93ceece4c32be99425364f7`
Product repair head: `6beda081ab7484481e72ad6eef24628a4acdc318`
Preserved repaired head: `99814f051370e66313ae500ad7c06a957eb9cd70`
Playwright contract repair head: `b850f0bee0bc21e47f8396b9a68b84d720d02d65`
Security evidence head: `5d06eeb6100b4d8b7510057f6e66ad7fb447d019`

## Goal and boundary

ScopeWeave owns its planner editor, validation presentation, task-domain mutation, and persistence. This change keeps an invalid Save action discoverable without allowing presentation state to replace domain validation: `saveEditor()` still recomputes the domain-facing validation result and refuses invalid mutation.

## Root cause

The original branch had converged to the protected-base tree while its PR body still claimed a focusable `aria-disabled` control. Production used native `disabled`, omitted `novalidate`, and offered no activation feedback. After repair, commit `0751de83741807842aeaa78359453a9380a62b07` reverted every repaired file under the label of a Checks re-kick, so #772 preserves the complete valid delta from `99814f051370e66313ae500ad7c06a957eb9cd70`. Review then identified that Playwright treats `aria-disabled="true"` as disabled for `toBeEnabled()` and actionability-gated `click()`, so the successor checks the native `disabled` property separately and activates the focused control with Enter.

## Shared dependency security RCA

Exact head `5d06eeb6100b4d8b7510057f6e66ad7fb447d019` reproduced CVE-2026-84363, CVE-2026-84364, and CVE-2026-84365 against protected-base `hono 4.13.0` in Security Scan run `36693173311`, `trivy-fs` job `109856722725`. This is not owned by the leaf UI delta. Dependency-only Draft #687 at `b5da0a539c46fb4600d2c492a459e937cbc22b98` is the canonical owner for Hono `4.13.0 → 4.13.7`; its Security/Server Tests/Fuzz/Semgrep evidence is GREEN, but its CodeQL PR run `34423378793` is failed. No lockfile copy, scanner ignore, or source-neutral rerun is permitted here. After #687 clears central CodeQL governance and integrates normally, #772 must be reconciled non-destructively and all consumer exact-head evidence regenerated.

## Exact-head acceptance matrix

| Capability | Current evidence | Status | Required action |
| --- | --- | --- | --- |
| Deterministic validation | Submit handler flushes validation and `saveEditor()` revalidates before mutation | GREEN (source contract) | Keep full E2E green |
| Semantics | Save remains native button and carries `aria-disabled` only while invalid | GREEN (source contract) | Verify accessibility tree |
| Keyboard/pointer/touch | Playwright contract checks native enabled state separately, focuses Save, activates with Enter, and retains toast/error/editor assertions | SOURCE CONTRACT GREEN; NOT EXECUTED HERE | Run exact-head Chromium plus pointer and touch browsers |
| Error/retry/focus | Existing field errors remain connected; invalid activation announces next action | PARTIAL | Verify focus order and retry after correcting fields |
| Responsive evidence | No current-head desktop/mobile/intermediate screenshots | FAIL | Capture all three viewport classes |
| WCAG 2.2 AA/reduced motion | Source semantics improved; real AT/contrast/motion audit absent | FAIL | Run axe and screen-reader/keyboard audit |
| Locales | UI remains Korean-only for this message; ko/en/ja/zh/vi/es/de/fr evidence absent | FAIL | Move copy to versioned translation resources and run locale E2E |
| Persistence/reload/rollback/race | Invalid path does not call mutation, but reload and concurrent editing evidence absent | FAIL | Exercise reload, stale/conflict, retry, and cleanup |
| Dependency security | Hono 4.13.0 produced three Trivy findings on evidence head; #687 is clean for Security but blocked by CodeQL | FAIL (owner-routed) | Integrate #687 only after its CodeQL gate is GREEN, then restack and rescan |
| Large data/import/export/recovery | Not changed by this focused editor fix | NOT REVALIDATED | Run current-head performance and recovery suites |

## Merge gate

Keep Draft until exact-head Checks, required review, real-browser interaction, responsive screenshots, WCAG evidence, all eight locales, applicable persistence/recovery evidence, and inherited dependency security are green. Queued, skipped, failed, or predecessor-head runs are not acceptance.
