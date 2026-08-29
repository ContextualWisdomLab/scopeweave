# Coverage evidence and 100% readiness

## Exact-head measurement

On 2026-08-29, the working head `88f31d42616eb86180ceddb64e9bcd2d156c81e4`
ran `npm run test:coverage` successfully. The generated c8 summary was:

| Metric | Covered | Total | Result |
| --- | ---: | ---: | ---: |
| Lines/statements | 3,399 | 7,722 | 44.01% |
| Functions | 78 | 236 | 33.05% |
| Branches | 798 | 984 | 81.09% |

The command's successful exit means the listed test cases completed; it does
not mean the 100% quality target was met.

## Scope boundary

The current c8 command includes `app.js`, `cloud-sync.js`, the CI helper, and
the Node server modules. Its coverage process runs Node test cases only.
Playwright launches the browser in a separate process, so the 89 passing E2E
tests are user-flow evidence but are not included in this c8 summary. The
repository therefore has no current single report proving 100% frontend,
backend, and edge-case coverage.

## Required remediation

1. Collect browser-side coverage for the shipped client scripts and merge it
   with the Node report without excluding uncovered production files.
2. Add tests for every remaining server branch and client error/empty-state
   path, including the current `app.js` and `cloud-sync.js` uncovered regions.
3. Make the exact-head coverage command fail below 100% lines, functions, and
   branches after the merged report exists.

Until those three conditions are true, G-06 remains **측정됨, 진행 중** and no
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
