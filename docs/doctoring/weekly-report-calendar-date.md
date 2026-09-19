# Weekly-report calendar-date boundary

## Incident

`buildWeeklyReport()` accepted the date-only value produced by the report UI,
but passed it directly to `new Date()`. ECMAScript interprets a date-only form
as UTC. In a negative-offset browser, `getDate()` and `getDay()` then observed
the preceding local day. For example, `2026-07-08` produced the week
`2026-07-07 .. 2026-07-13` under `America/Los_Angeles` instead of the intended
Monday–Sunday range `2026-07-06 .. 2026-07-12`.

## Reproduction and repair

The RED contract runs the same fixed calendar date under `UTC`,
`America/Los_Angeles`, and `Asia/Seoul`. The pre-repair implementation fails
only the negative-offset case, proving this is a calendar/instant boundary
rather than locale copy or task-data behavior.

The production repair treats a strict `YYYY-MM-DD` input as local calendar
midnight, formats dates from local calendar fields, and advances dates with
`setDate()` rather than fixed 24-hour millisecond increments. Non-date-only
inputs retain the existing `Date` parsing boundary, and invalid inputs still
fail closed with an empty report.

## Invariants and rollback

- A date selected by a user denotes the same calendar date in every supported
  browser time zone.
- Week ranges remain Monday through Sunday.
- Task dates stay immutable strings; this repair does not reinterpret stored
  task timestamps or change persistence.
- Roll back only with an equivalent implementation that passes the three-zone
  regression and the complete unit/API suites.

## Reference

ECMA International. (n.d.). *ECMAScript language specification: Date time
string format*. https://tc39.es/ecma262/#sec-date-time-string-format
