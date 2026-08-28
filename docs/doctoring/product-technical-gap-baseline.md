# Product/technical gap baseline doctoring record

## 2026-08-28

- Reconciled the baseline to protected `develop@2c328875e00e86537df3e965170be80532571cad`.
- Distinguished shipped behavior from open PR submissions so #621/#624 features are
  not reported as already available on `develop`.
- Recorded the exact #624 squash merge into the #621 feature branch and the subsequent
  #621 exact head `4c8d09d17024202a1f5236ef62b31a8b5d9480c1`, including the CSV search
  reset, sample-onboarding persistence fixes, and debounced search rerender.
- Recorded #610's exact-head review and gate evidence as non-authorizing: the prior
  cloud E2E failure exposed `??` preserving falsy text metadata in JSON sync, which
  was fixed in `3bb2bd95905d590fe3d1d0d9a8fc6c6ec133c04a`; its replacement Checks
  were pending at doctoring time, with approval still absent.
- Added exact-head evidence for #515, stacked draft #623, and draft security PR #552;
  preserved their review/approval and provider-gate limits instead of treating green
  local or partial hosted results as merge authority.
- Research mapping remains anchored to ISO 21502, ISO 21511, ISO 21508, WCAG 2.2,
  NIST SSDF 1.1, and the preserved PM-analysis sources listed in the baseline.
- Reconciled newly observed PRs: retained #588 as the single outbound-webhook
  SSRF lane, recorded #628's accessibility result and pre-existing modulepreload
  E2E gap, and closed duplicate #626/#627 lanes.
- Repaired #608's current-head accessibility defects: synchronized the persistent
  empty-state help element's DOM `hidden` state and updated the legacy empty-state
  E2E assertion to the native-disabled/`aria-describedby` contract; replacement
  focused E2E and unit checks passed locally.
- Repaired #587's direct `application_routes_core.mjs` rate-limit boundary by
  reusing the validated trusted-proxy middleware and adding a direct-core probe;
  full coverage/API validation passed locally, while replacement hosted Checks
  remained queued and qualifying approval was absent.
