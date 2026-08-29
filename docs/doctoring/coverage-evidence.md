# Coverage evidence and 100% readiness

## Exact-head measurement

On 2026-08-29, PR #632 working head `b8c188badafcd559c46737550ddb598fead17c52`
ran `BASE_URL=http://127.0.0.1:4174 npm run test:coverage` successfully with
a dedicated ScopeWeave static server. The merged Node/Chromium summary
contained 285 source entries:

| Metric | Covered | Total | Result |
| --- | ---: | ---: | ---: |
| Lines/statements | 8,177 | 8,688 | 94.11% |
| Functions | 291 | 298 | 97.65% |
| Branches | 2,297 | 2,464 | 93.22% |

The command's successful exit means the listed test cases completed and the
Node plus browser reports were merged; it does not mean the 100% quality
target was met. `node scripts/ci/check-coverage.mjs` fails with all four
thresholded metrics below 100%.

## Scope boundary

The Node phase uses c8 with `--all` for `app.js`, `cloud-sync.js`,
`analytics.js`, the CI helper, and every `server/*.mjs` module. The browser
phase collects Chromium V8 JavaScript coverage during all 95 passing E2E
tests, converts the shipped client scripts, and merges both reports into one
Istanbul summary. Uncovered production lines remain in the report.

## Required remediation

1. Add tests for every remaining server branch and client error/empty-state
   path, including the current `app.js` and `cloud-sync.js` uncovered regions.
2. Keep the merged exact-head report and make the strict command pass 100%
   lines, statements, functions, and branches.

Until those conditions are true, G-06 remains **측정됨, 진행 중** and no
release note may describe the repository as having 100% coverage.

## References

bcoe. (n.d.). *c8: Output coverage reports using Node.js' built-in coverage*
[Computer software]. GitHub. Retrieved August 29, 2026, from
https://github.com/bcoe/c8

Microsoft. (n.d.). *Coverage*. Playwright. Retrieved August 29, 2026, from
https://playwright.dev/docs/api/class-coverage

## Rollback

Remove this record, the G-06 baseline row, and its changelog entry together;
there is no runtime or persisted-data impact.
