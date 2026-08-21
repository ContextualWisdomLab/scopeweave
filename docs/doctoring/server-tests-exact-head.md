# Exact-head and live-base CI execution evidence

## Status and authority

**Status: active PR #523 evidence, not protected-`develop` shipped truth.**

This record belongs to issue #522 / PR #523. Protected `develop` remains shipped truth until one unchanged integrated head satisfies the live ruleset, deterministic checks, security and dependency gates, resolved-review requirements, and any qualifying independent approval required after the latest push.

## Buyer/control objective

A green CI badge is not defensible evidence when the job executed a different revision from the contributor head under review, when a base-sensitive comparison silently used an old pull-request base snapshot, or when a stacked pull request never received a required analysis lane. ScopeWeave therefore keeps four identities separate:

1. the exact immutable contributor head under review;
2. the pull-request base snapshot recorded in event/PR metadata;
3. the live protected base ref tip independently resolved when base-sensitive evidence executes; and
4. the actual checkout SHA attested by each deterministic/security job.

GitHub `pull_request` workflows normally expose a synthetic `refs/pull/<number>/merge` ref and corresponding merge `GITHUB_SHA`. Synthetic-merge success remains useful integration evidence, but it does not substitute for exact contributor-head execution. Likewise, `github.event.pull_request.base.sha` is historical event metadata rather than ScopeWeave's live protected-base authority.

## Server Tests exact-head repair

Before this PR, both jobs in `.github/workflows/server-tests.yml` used `actions/checkout` without an explicit `ref`, so pull-request execution followed GitHub's synthetic merge revision.

The realistic RED regression was committed at `7c6810211a211bb0fd09c36476b5ea47c1c0af46`. Hosted Server Tests run `31924337433`, job `95109405299`, fetched synthetic merge commit `120def420dec9abe154353fa699e6a69e0388268`; the new contract failed because neither job selected the contributor head.

Commit `0f247d2e05fd8c9c2f69e617efd369ee7aea005d` changed both jobs to select `${{ github.event.pull_request.head.sha || github.sha }}` with `persist-credentials: false`. Each job binds `EXPECTED_CHECKOUT_SHA` to the same expression, runs `git rev-parse HEAD`, and fails closed if the actual revision differs. The fallback preserves exact protected-branch push execution.

The control keeps the unprivileged `pull_request` event, `contents: read`, immutable action pins, disabled credential persistence, and existing unit/API/browser-E2E workloads. It adds no secret-bearing contributor execution, merge-ref synthesis, temporary writer workflow, or bypass.

## Exact owned coverage and provenance

The current Server Tests lane treats coverage as evidence rather than a best-effort report:

- server coverage uses c8 with `--all --check-coverage --per-file` and exact 100% statements, branches, functions, and lines over registered owned production modules;
- browser coverage exercises served production `/analytics.js`, `/app.js`, and `/cloud-sync.js`, records SHA-256 for served bytes, independently hashes checked-out source, rejects a source/served provenance mismatch, and requires exact 100% statements, branches, functions, and lines;
- every Playwright page in the test context is instrumented before navigation when created through `context.newPage()`, and coverage is collected before an explicitly closed page becomes unavailable;
- failure diagnostics and uploaded evidence are scoped to a failed coverage step so unrelated test/setup failures do not cascade into misleading coverage errors; and
- structural regression contracts keep the production modules, test cases, exact-head assertions, and coverage thresholds from silently disappearing.

Coverage success on a predecessor head, synthetic merge, skipped lane, or different served source is non-authorizing.

## CodeQL required-context, default-setup authority, and stacked-PR repair

Protected `develop` requires `Analyze (javascript-typescript)` and `Analyze (python)`. Current repository evidence uses **one** checked-in CodeQL workflow for those protected contexts:

- `.github/workflows/codeql-required.yml` performs real exact-head analysis with `upload: never` and `upload-database: false`; it supplies deterministic required contexts without publishing SARIF or a CodeQL database;
- its job permission is `contents: read` only, because this non-publishing lane has no need for `security-events: write`;
- GitHub CodeQL default setup remains the sole SARIF publication authority; and
- the former repository advanced publisher `.github/workflows/codeql.yml` has been retired instead of leaving a disabled/conflicting advanced setup in source.

The first replacement attempt at `612dcb6ed0ff17b03e30baacb301dc006bac7d6f` reached CodeQL analysis but GitHub rejected advanced-configuration SARIF publication while default setup was authoritative. GitHub's current troubleshooting guidance states that enabling default setup disables existing advanced CodeQL workflow files and blocks CodeQL analysis API uploads from them; when the workflow is no longer needed, the file should be deleted. Retaining the stale publisher therefore supplied neither trustworthy evidence nor a useful fallback.

Fresh review later exposed two additional control defects. First, two repository workflows had been configured to emit the same protected `Analyze (...)` names, making required-context provenance ambiguous. Second, both workflows had historically limited `pull_request` to base branch `develop`, so stacked child PRs could receive no repository analysis.

The final repair sequence is test-first and single-authority:

1. `4cba72546115a4877705f8e079d6ca635b948161` established a failing contract that default-setup publication authority must not coexist with a checked-in advanced publisher;
2. `c14ac41168af120e584c0d5578e8260b5c40cf79` deleted the stale `.github/workflows/codeql.yml` publisher;
3. `bcad2b61a4220f11ab28d8527c54b2c3ae893b19` narrowed the stacked-PR contract to the remaining required workflow; and
4. `9c5d7e163cf3f114d2811416421b4825a2d1bddc` added a least-privilege regression before `19140bba86f7dc088eeb133465fbc91343edc7fc` removed the unused `security-events: write` permission.

The surviving required workflow retains immutable CodeQL Action pins, explicit exact-head checkout/runtime attestation, disabled checkout credential persistence, no base-branch filter on `pull_request`, and the unprivileged event boundary. No `pull_request_target`, secret-bearing contributor execution, analysis weakening, SARIF publication duplication, or required-context bypass was introduced.

## OSV exact-head and live-base differential scanning

The former repository OSV lane delegated to Google's reusable PR workflow, whose candidate selection follows `$GITHUB_SHA` and therefore the synthetic merge revision on ordinary pull requests. PR #523 instead owns revision selection locally while preserving immutable scanner/reporter pins.

PR #487 established that `google/osv-scanner-action@v2.5.0` points to `8deb546fdb875b9996d27d4950be7312dac076a1`; the release's direct scanner and reporter steps use `06b2ab4348248b456ee06c9e953637f55e03504f`. PR #523 uses that direct revision while controlling checkout identity itself.

A second defect was that the baseline originally used `github.event.pull_request.base.sha` and called it the live base. Test-only commit `d8d6d0bd0e3c343b52986856b0df18181639ceb7` required the named protected base ref and rejected the snapshot SHA. Production commit `e527c7fadbdea523905bf985121d0fa9d8809f2b` changed the baseline checkout to `${{ github.event.pull_request.base.ref }}` and records the resolved SHA with `git rev-parse HEAD`.

The current OSV sequence is:

1. checkout the current protected base **ref** with credentials disabled;
2. record the resolved base SHA and ref identity;
3. scan the resolved baseline into `old-results.json`;
4. checkout the exact immutable contributor head with credentials disabled and `clean: false` so baseline evidence survives;
5. attest `git rev-parse HEAD == EXPECTED_HEAD_SHA`;
6. scan the exact contributor head into `new-results.json`;
7. compare introduced findings with the pinned reporter; and
8. preserve generated candidate-head SARIF for non-cancelled finding failures according to the current OSV evidence contract.

A merge or release decision must still resolve protected `develop` again after all checks because the branch can advance after any workflow starts.

## Executable regression contract

`tests/unit/workflow-exact-head-contract.test.mjs`, `tests/unit/codeql-stacked-pr-trigger-contract.test.mjs`, `tests/unit/codeql-workflow-supply-chain.test.mjs`, the coverage contracts, and the associated package registrations collectively require:

- exact contributor-head checkout and runtime SHA attestation for both Server Tests jobs;
- exact contributor-head checkout/runtime attestation for the repository CodeQL required lane and property fuzz;
- disabled checkout credential persistence and no privileged `pull_request_target` path;
- both protected `Analyze (...)` identities/languages from one repository workflow;
- CodeQL required-context analysis with `upload: never`, `upload-database: false`, and no unused code-scanning write permission while GitHub default setup owns publication;
- absence of the stale advanced CodeQL publisher workflow;
- CodeQL execution for stacked PRs as well as `develop`-bound PRs;
- OSV baseline selection by named base ref, with explicit rejection of `github.event.pull_request.base.sha` as live authority;
- OSV exact-head checkout with `clean: false` and runtime SHA verification;
- immutable scanner/reporter/action revisions; and
- exact owned production coverage/provenance requirements, including secondary Playwright pages.

Structural contracts complement rather than replace hosted runtime evidence. Every changed head must prove its own execution.

## Evidence semantics and external owner boundaries

Exact contributor-head checkout reduces evidence ambiguity; it is not code signing, artifact provenance, or a substitute for SAST, dependency review, supply-chain controls, or independent review.

Neutral, skipped, cancelled, absent, stale, predecessor-head, rate-limited, model-only, status-only, synthetic-only, or configuration-mismatch records are non-passing.

Organization-owned controls remain separate authorities. In particular, the current `.github` owner lanes for Strix incomplete/provider-failure handling and required OpenCode/Noema formal verdict integrity must integrate through their dedicated writer before ScopeWeave can regenerate and rely on that evidence. ScopeWeave must not reproduce those central controls locally.

## Rollback and recovery

Before protected integration, rollback is source-only: remove the PR-owned workflow/test/coverage/doctoring changes together. After protected integration, do not silently restore default pull-request checkout and then label synthetic merge success as contributor-head evidence. Do not restore `github.event.pull_request.base.sha` as live base authority, and do not reintroduce a CodeQL base filter that skips stacked PR heads.

If CodeQL publication ownership later moves from GitHub default setup back to repository advanced configuration, treat that as an explicit control-plane migration: disable default setup through the authorized GitHub security configuration path, add one reviewed advanced publisher with unique check identity, restore only the permissions needed for publication, and update protected-context, exact-head, and publication-authority regressions together. Do not re-add a competing publisher as a speculative fallback.

## References

GitHub. (n.d.). *Actions checkout*. GitHub. https://github.com/actions/checkout

GitHub. (n.d.). *CodeQL Action analyze action definition*. GitHub. https://github.com/github/codeql-action/blob/main/analyze/action.yml

GitHub. (n.d.). *Configuring default setup for code scanning*. GitHub Docs. https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning

GitHub. (n.d.). *Events that trigger workflows*. GitHub Docs. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (n.d.). *Two CodeQL workflows*. GitHub Docs. https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/two-codeql-workflows

Google. (2026). *OSV-Scanner Action v2.5.0* [Source code]. GitHub. https://github.com/google/osv-scanner-action/releases/tag/v2.5.0
