# Schedule outcome derivation domain

## Status and scope

This document records **active stacked work**, not protected-`develop` shipped truth. The branch `feat/schedule-outcome-domain-287` is stacked on the exact current head of PR #515 (`feat/work-item-hierarchy-domain-287`) and implements the next bounded domain slice of issue #287. Protected `develop` does not expose these derived outcomes until the prerequisite hierarchy work and this child are independently reviewed, reconciled, integrated, and verified.

The slice is intentionally framework-neutral. It adds no UI, Hono route, database migration, persistence adapter, tenant authorization rule, forecast model, Waterfall/Agile projection, or entitlement/security behavior. Later adapters may persist a result only together with its derivation version and source-version references; they must not treat this pure domain function as authorization to create or modify source facts.

## Buyer decision contract

The domain turns schedule facts into one mutually exclusive decision label while retaining missingness and provenance instead of manufacturing certainty. The versioned vocabulary is:

- `not_started`
- `in_progress`
- `completed_early`
- `completed_on_time`
- `completed_late`
- `not_performed`
- `skipped`
- `cancelled`
- `blocked`

`deriveScheduleOutcome()` can also return `outcome: null` with a concrete `decisionRequired` value. That is deliberate: an approved baseline finish is required before ScopeWeave labels a completed item early/on-time/late, and untouched work after its execution window requires an accountable outcome decision rather than an inferred failure.

Observed facts remain distinct from interpretation. The returned immutable explanation retains baseline identity, baseline finish, execution-window end, observation date, actual start/finish, progress, tolerance, explicit reason evidence, blocker history, unresolved blocker count, and finish variance. The derivation identifier is `schedule-outcome/v1`.

## Deterministic rules

Calendar comparisons use strict `YYYY-MM-DD` values converted to UTC calendar-day ordinals. This avoids deployment-time-zone drift and correctly traverses leap days. `onTimeToleranceDays` is a non-negative integer and is applied symmetrically around the approved baseline finish: a variance below `-tolerance` is early, above `+tolerance` is late, and the inclusive interval is on time.

A finish date is completion evidence only when progress is exactly 100%. An actual start or positive progress without a finish is `in_progress`. An unresolved recorded dependency, decision, or constraint produces `blocked` before ordinary in-progress/not-started classification, but completed work cannot simultaneously remain blocked.

`skipped`, `cancelled`, and `not_performed` require explicit reason events with actor and timestamp. Cancellation additionally requires an approval identifier. `not_performed` is accepted only after the execution window has concluded and only when no actual execution evidence exists. The domain rejects contradictory terminal evidence rather than selecting a convenient label.

The exact window rule is conservative: `asOfDate > executionWindowEndDate` means the window has concluded. On the configured end date itself, untouched work remains `not_started`; adapters that need an intraday cutoff must supply an explicit later calendar observation or introduce a separately reviewed timestamp policy rather than smuggling local-clock behavior into this domain.

## TDD and executable traceability

The branch was cut from PR #515 exact head `322b8d7de4645f51560419b6a5d8e4826e95964b` after a fresh protected-base and current-head review/check refetch.

- `c365c2d33119fb4f92be634b567c9435f0acfcbc` added the primary behavior contract while `server/schedule_outcome_domain.mjs` did not exist. The import was therefore structurally RED with `ERR_MODULE_NOT_FOUND`; no hosted result is claimed for that pre-PR commit.
- `c4c03805aaf92fadac4a1ab7747c64708b280286` added the production derivation module.
- `099a29a5d1cb87409151b04a3462398de478f1e5` registered the module and primary behavior contract in the canonical c8 producer.
- `95836a4a4d572e11b54dccebbac391446822cea4` locked that production instrumentation/test registration into the coverage-script contract.
- `5b9d44c2c5b6470f5eda750214410d1e25226827` expanded realistic failure-boundary coverage for malformed evidence, impossible temporal states, blocker lifecycle, and cancellation authority.
- `1e43a1f70174163a8d7633cbd3548204719c2c77` registered those edge cases in normal unit and c8 coverage execution.
- `fcdf2d2e766b5c8e39de461d11499f3f96be112c` locked the edge-case registration into the coverage-script contract.

Hosted exact-current-head statement/branch/function/line percentages remain authoritative once the PR exists. Predecessor, local-only, pending, skipped-required, neutral, model-only, or status-only evidence is not promoted to passing.

## Evidence boundaries and buyer safety

This module does not infer tenant membership, owner accountability, baseline approval, or reason-event authorization. Production adapters must establish those authorities before constructing the input. In particular, a browser-provided reason actor, cancellation approval, baseline identity, or organization identifier cannot become authoritative merely because the domain validates its shape.

No secret, credential, raw attachment, provider payload, or PII-specific field is required by this slice. Later persistence should store only the source identifiers and audit metadata needed to reproduce the decision, under ScopeWeave's purpose-bound access, tenant isolation, retention, export logging, and recovery controls.

The domain is deterministic and independent of model judgment. LLM output may later explain or summarize schedule evidence, but it must not replace this deterministic outcome gate or silently mutate the underlying facts.

## Standards and research rationale

ISO 21508:2026 is the current published second edition of the earned value management guidance standard. It reinforces integration of scope, schedule, cost, baseline, monitoring, and control evidence, but it does not prescribe ScopeWeave's nine-label outcome taxonomy or this tolerance policy. Those labels are a product decision designed to keep actual facts, approved baselines, explicit reason events, and derived interpretation separate.

ISO 21513:2026 is the current published guidance for post-project and post-programme evaluation. Its emphasis on actual outcomes and structured evaluation supports preserving reproducible actual-versus-expected evidence rather than erasing source facts after classification. This slice does not claim to implement the full evaluation standard.

Behavioral research also supports preserving historical and baseline evidence explicitly. Lorko, Servátka, and Zhang's incentivized experiment found persistent anchoring in project-duration estimates, including anchoring on planners' own prior estimates. Their later experiment found that historical information about similar projects improved duration-estimation accuracy more reliably than merely adding project-detail information. ScopeWeave therefore retains baseline identity and variance evidence so later estimation-bias/calibration views can compare plans with realized outcomes without conflating the original estimate with the observed result.

## Rollback and integration

Before persistence/API/UI integration, rollback removes `server/schedule_outcome_domain.mjs`, its focused tests, package/coverage registrations, this doctoring record, and the corresponding CHANGELOG entry together. There is no database state to reverse.

Do not integrate this child independently of #515. After #515 reaches protected `develop`, reconcile this bounded semantic slice against the resulting protected head and rerun every applicable repository-native and organization-required CI/security/dependency/supply-chain/coverage gate. A qualifying independent current-head/last-push approval remains mandatory under the live rulesets; model reviews and author-only evidence do not satisfy it.

## References

International Organization for Standardization. (2026). *Project, programme and portfolio management—Earned value management* (ISO Standard No. 21508:2026). https://www.iso.org/standard/87899.html

International Organization for Standardization. (2026). *Project, programme and portfolio management—Guidance on post-project and post-programme evaluation* (ISO Standard No. 21513:2026). https://www.iso.org/standard/63585.html

Lorko, M., Servátka, M., & Zhang, L. (2019). Anchoring in project duration estimation. *Journal of Economic Behavior & Organization, 162*, 49–65. https://doi.org/10.1016/j.jebo.2019.04.014

Lorko, M., Servátka, M., & Zhang, L. (2021). Improving the accuracy of project schedules. *Production and Operations Management, 30*(6), 1633–1646. https://doi.org/10.1111/poms.13299
