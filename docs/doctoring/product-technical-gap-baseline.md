# Product/technical gap baseline doctoring record

## 2026-08-28

- Reconciled the baseline to protected `develop@2c328875e00e86537df3e965170be80532571cad`.
- Distinguished shipped behavior from open PR submissions so #621/#624 features are
  not reported as already available on `develop`.
- Recorded the exact #624 squash merge into the #621 feature branch and the subsequent
  #621 exact head `4c8d09d17024202a1f5236ef62b31a8b5d9480c1`, including the CSV search
  reset, sample-onboarding persistence fixes, and debounced search rerender.
- Recorded #610 OpenCode/Strix gate failures as non-authorizing external evidence,
  including the missing current-head verdict and provider HTTP 500 report absence.
- Added exact-head evidence for #515, stacked draft #623, and draft security PR #552;
  preserved their review/approval and provider-gate limits instead of treating green
  local or partial hosted results as merge authority.
- Research mapping remains anchored to ISO 21502, ISO 21511, ISO 21508, WCAG 2.2,
  NIST SSDF 1.1, and the preserved PM-analysis sources listed in the baseline.
- Reconciled newly observed PRs: retained #588 as the single outbound-webhook
  SSRF lane, recorded #628's accessibility result and pre-existing modulepreload
  E2E gap, and closed duplicate #626/#627 lanes.
