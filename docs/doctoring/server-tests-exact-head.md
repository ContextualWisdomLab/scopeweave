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
- browser coverage exercises served production `/app.js` and `/cloud-sync.js`, records SHA-256 for served bytes, independently hashes checked-out source, rejects a source/served provenance mismatch, and requires exact 100% statements, branches, functions, and lines;
- failure diagnostics and uploaded evidence are scoped to a failed coverage step so unrelated test/setup failures do not cascade into misleading coverage errors; and
- structural regression contracts keep the production modules, test cases, exact-head assertions, and coverage thresholds from silently disappearing.

Coverage success on a predecessor head, synthetic merge, skipped lane, or different served source is non-authorizing.

## CodeQL required-context and stacked-PR repair

Protected `develop` requires `Analyze (javascript-typescript)` and `Analyze (python)`. PR #523 therefore retains two repository CodeQL workflows with different evidence roles:

- `.github/workflows/codeql-required.yml` performs real exact-head analysis with `upload: never` so it can supply deterministic required contexts without competing with GitHub CodeQL default setup for SARIF publication; and
- `.github/workflows/codeql.yml` remains the repository advanced/publisher definition. It is **not removed**. Both workflows use immutable CodeQL Action pins, explicit exact-head checkout/runtime attestation, disabled checkout credential persistence, and the unprivileged `pull_request` trust boundary.

The first replacement attempt at `612dcb6ed0ff17b03e30baacb301dc006bac7d6f` reached CodeQL analysis but GitHub rejected advanced-configuration SARIF publication while default setup was authoritative. `upload: never` is the narrow required-context repair; publication authority remains separate evidence.

### Stacked pull-request trigger defect

Fresh review later found both CodeQL workflows limited `pull_request` to base branch `develop`. ScopeWeave uses stacked delivery trains whose child PRs target another feature branch, so those exact contributor heads could receive no repository CodeQL run even though the eventual protected integration requires the same analysis contexts.

The repair was again test-first:

1. `196227d0a2f6e030fbfde70ea0a8e5fe85312032` added `tests/unit/codeql-stacked-pr-trigger-contract.test.mjs` while the production base filter still existed, establishing the RED contract;
2. `eb05b384c1c4971d5e73f9cf616eb3c7ac9c445f` removed only the CodeQL pull-request base filters, making both workflows execute for develop-bound and stacked PRs while retaining exact-head attestation and the unprivileged event boundary; and
3. `058c2cd446826935aae26eefca2d5d12c6acd29a` hardened the regression so explanatory YAML comments do not create a false failure while a nested `branches:` filter still does.

No `pull_request_target`, secret-bearing contributor execution, analysis weakening, or required-context bypass was introduced.

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
8. publish candidate-head SARIF through the pinned CodeQL upload action.

A merge or release decision must still resolve protected `develop` again after all checks because the branch can advance after any workflow starts.

## Executable regression contract

`tests/unit/workflow-exact-head-contract.test.mjs`, `tests/unit/codeql-stacked-pr-trigger-contract.test.mjs`, the coverage contracts, and the associated package registrations collectively require:

- exact contributor-head checkout and runtime SHA attestation for both Server Tests jobs;
- exact contributor-head checkout/runtime attestation for CodeQL and property fuzz;
- disabled checkout credential persistence and no privileged `pull_request_target` path;
- both required `Analyze (...)` identities/languages;
- CodeQL required-context analysis with `upload: never` while retaining the separate publisher workflow;
- CodeQL execution for stacked PRs as well as `develop`-bound PRs;
- OSV baseline selection by named base ref, with explicit rejection of `github.event.pull_request.base.sha` as live authority;
- OSV exact-head checkout with `clean: false` and runtime SHA verification;
- immutable scanner/reporter/action revisions; and
- exact owned production coverage/provenance requirements.

Structural contracts complement rather than replace hosted runtime evidence. Every changed head must prove its own execution.

## Evidence semantics and external owner boundaries

Exact contributor-head checkout reduces evidence ambiguity; it is not code signing, artifact provenance, or a substitute for SAST, dependency review, supply-chain controls, or independent review.

Neutral, skipped, cancelled, absent, stale, predecessor-head, rate-limited, model-only, status-only, synthetic-only, or configuration-mismatch records are non-passing.

Organization-owned controls remain separate authorities. In particular, the current `.github` owner lanes for Strix incomplete/provider-failure handling and required OpenCode/Noema formal verdict integrity must integrate through their dedicated writer before ScopeWeave can regenerate and rely on that evidence. ScopeWeave must not reproduce those central controls locally.

## Rollback and recovery

Before protected integration, rollback is source-only: remove the PR-owned workflow/test/coverage/doctoring changes together. After protected integration, do not silently restore default pull-request checkout and then label synthetic merge success as contributor-head evidence. Do not restore `github.event.pull_request.base.sha` as live base authority, and do not reintroduce a CodeQL base filter that skips stacked PR heads.

If CodeQL publication ownership later moves from GitHub default setup back to repository advanced configuration, treat that as a control-plane migration and update publication authority, required contexts, exact-head regressions, and protected-branch evidence together.

## References

GitHub. (n.d.). *Actions checkout*. GitHub. https://github.com/actions/checkout

GitHub. (n.d.). *CodeQL Action analyze action definition*. GitHub. https://github.com/github/codeql-action/blob/main/analyze/action.yml

GitHub. (n.d.). *Configuring default setup for code scanning*. GitHub Docs. https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning

GitHub. (n.d.). *Events that trigger workflows*. GitHub Docs. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (n.d.). *Two CodeQL workflows*. GitHub Docs. https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/two-codeql-workflows

Google. (2026). *OSV-Scanner Action v2.5.0* [Source code]. GitHub. https://github.com/google/osv-scanner-action/releases/tag/v2.5.0
