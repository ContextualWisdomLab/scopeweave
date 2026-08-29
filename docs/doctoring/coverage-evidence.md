# Coverage evidence and 100% readiness

## Exact-head measurement

On 2026-08-29, exact head `5ae5fef2b84ecae96f64f95b1485e5232d15c7ae`
ran `npm run test:coverage` successfully. The merged Node/Chromium summary
contained 267 source entries:

| Metric | Covered | Total | Result |
| --- | ---: | ---: | ---: |
| Lines/statements | 7,184 | 8,675 | 82.81% |
| Functions | 264 | 290 | 91.03% |
| Branches | 2,032 | 2,199 | 92.40% |

The command's successful exit means the listed test cases completed and the
Node plus browser reports were merged; it does not mean the 100% quality
target was met. `node scripts/ci/check-coverage.mjs` fails with all four
thresholded metrics below 100%.

## Scope boundary

The Node phase uses c8 with `--all` for `app.js`, `cloud-sync.js`,
`analytics.js`, the CI helper, and every `server/*.mjs` module. The browser
phase collects Chromium V8 JavaScript coverage during all 89 passing E2E
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
