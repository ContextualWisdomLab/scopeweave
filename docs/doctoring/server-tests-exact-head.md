# Exact-head and live-base CI execution evidence

## Status and authority

**Status: active PR #523 evidence, not protected-`develop` shipped truth.**

This record belongs to issue #522 / PR #523. Protected `develop` remains shipped truth until one unchanged integrated head satisfies the live ruleset, deterministic checks, security and dependency gates, resolved-review requirements, and any qualifying independent approval required after the latest push.

## Buyer/control objective

A green CI badge is not defensible evidence if a job executed a different contributor revision from the one under review, or if a base-sensitive comparison silently used an old pull-request base snapshot instead of the current protected branch tip. ScopeWeave therefore keeps three identities separate:

1. the exact immutable contributor head under review;
2. the pull-request base snapshot recorded in event/PR metadata; and
3. the live protected base ref tip resolved when base-sensitive evidence executes.

GitHub documents that `pull_request` workflow runs normally expose a synthetic `refs/pull/<number>/merge` ref and that `GITHUB_SHA` is the corresponding merge commit. The `actions/checkout` documentation separately shows how to checkout an explicit contributor commit or named branch. Synthetic-merge success remains useful integration evidence, but it cannot substitute for exact contributor-head evidence; similarly, `github.event.pull_request.base.sha` is a snapshot identity and is not used as ScopeWeave's live protected-base authority.

## Server Tests root cause and RED evidence

Before this PR, both jobs in `.github/workflows/server-tests.yml` invoked the pinned `actions/checkout` action with `persist-credentials: false` but no `ref`. On a pull request, the action therefore followed the event's default synthetic merge ref.

The realistic RED regression was committed at contributor head `7c6810211a211bb0fd09c36476b5ea47c1c0af46`. Hosted Server Tests run `31924337433`, job `95109405299`, fetched and executed synthetic merge commit `120def420dec9abe154353fa699e6a69e0388268` from `refs/remotes/pull/523/merge`; the new contract failed because neither job selected the contributor head.

Commit `0f247d2e05fd8c9c2f69e617efd369ee7aea005d` changed both Server Tests jobs to select `${{ github.event.pull_request.head.sha || github.sha }}` with `persist-credentials: false`. Each job binds `EXPECTED_CHECKOUT_SHA` to the same expression, runs `git rev-parse HEAD`, and fails closed if the actual revision differs. The fallback preserves exact protected-`develop` push execution.

The control keeps the unprivileged `pull_request` event, `contents: read`, immutable action pins, disabled credential persistence, and the existing unit/API and browser-E2E workloads. It adds no secret, token authority, merge-ref synthesis, temporary writer workflow, or bypass.

## Required CodeQL context recovery

Acceptance testing exposed a second CI-integrity defect. Protected `develop` requires `Analyze (javascript-typescript)` and `Analyze (python)`, while the repository's historical CodeQL workflow was disabled under GitHub CodeQL default setup.

PR #523 restores those deterministic context names through `.github/workflows/codeql-required.yml`. It selects and verifies the exact contributor head, retains `persist-credentials: false`, analyzes both required languages, and remains on the unprivileged `pull_request` boundary.

The first hosted replacement attempt on contributor head `612dcb6ed0ff17b03e30baacb301dc006bac7d6f` reached CodeQL analysis but failed when GitHub rejected advanced-configuration SARIF publication while default setup was authoritative. The narrow repair uses the CodeQL Action's supported `upload: never` mode. GitHub default setup remains the code-scanning publication authority while the repository-owned workflow performs real local analysis to supply the protected required contexts.

The disabled historical `.github/workflows/codeql.yml` source is removed after the replacement workflow proved active and successful. This reduces source ambiguity without disabling CodeQL default setup.

## OSV contributor-head and live-base differential scanning

The former repository OSV lane delegated to Google's reusable pull-request workflow, whose candidate selection follows `$GITHUB_SHA` and therefore the synthetic merge revision on normal pull-request events. PR #523 instead owns the differential scan locally while preserving immutable direct scanner/reporter pins.

PR #487 established that upstream `google/osv-scanner-action@v2.5.0` points to `8deb546fdb875b9996d27d4950be7312dac076a1`; that release's reusable workflow pins its direct scanner and reporter steps to `06b2ab4348248b456ee06c9e953637f55e03504f`. PR #523 uses that direct revision while controlling revision selection itself.

### Stale-base snapshot defect and TDD repair

An additional evidence defect remained in the first PR #523 implementation: the baseline scanner checked out `github.event.pull_request.base.sha` and labeled it the live base. That value is pull-request/event snapshot evidence, not an independently resolved current protected branch tip. A base-sensitive dependency comparison can therefore become stale as `develop` moves.

Test-only commit `d8d6d0bd0e3c343b52986856b0df18181639ceb7` changed `tests/unit/workflow-exact-head-contract.test.mjs` to require the named protected base ref, require the ref identity in baseline evidence, and explicitly reject `github.event.pull_request.base.sha` in the OSV workflow. At that commit, the production workflow still contained the snapshot SHA checkout, so the executable contract and production source were deliberately RED.

Production commit `e527c7fadbdea523905bf985121d0fa9d8809f2b` changed the OSV baseline to checkout `${{ github.event.pull_request.base.ref }}`. `actions/checkout` therefore resolves the protected branch name at runner execution rather than accepting the PR snapshot SHA. The following step records the actual resolved revision using `git rev-parse HEAD` together with `BASE_REF`. Merge classification must still freshly resolve `develop` again after checks because any live base can advance after a workflow starts.

The current OSV comparison sequence is:

1. checkout the current protected base **ref** with credentials disabled;
2. record the resolved protected-base SHA and ref identity;
3. scan that resolved baseline into `old-results.json` with the v2.5.0 direct scanner pin;
4. checkout the exact immutable `github.event.pull_request.head.sha` with credentials disabled and `clean: false` so the baseline result survives;
5. verify `git rev-parse HEAD` equals `EXPECTED_HEAD_SHA`;
6. scan the exact contributor head into `new-results.json` with the same v2.5.0 pin;
7. compare introduced findings with the v2.5.0 reporter pin; and
8. upload candidate-head SARIF through the pinned CodeQL upload action.

The job identity remains `scan`, matching protected-base code-scanning identity. A neutral configuration-mismatch record is not treated as passing security evidence.

## Executable regression contract

`tests/unit/workflow-exact-head-contract.test.mjs`, registered in normal `test:unit`, requires:

- exactly two Server Tests exact-head checkout refs and runtime expected-SHA bindings;
- `git rev-parse HEAD` verification in both Server Tests jobs;
- disabled checkout credential persistence and no `pull_request_target`;
- both protected CodeQL `Analyze (...)` context names and required languages;
- CodeQL exact-head checkout, expected/actual SHA comparison, disabled credential persistence, and `upload: never`;
- the stable OSV `scan` job identity;
- OSV baseline selection by `github.event.pull_request.base.ref`, with the base ref recorded in evidence;
- explicit rejection of `github.event.pull_request.base.sha` as a live-base authority;
- exact immutable contributor-head checkout and runtime SHA verification;
- `clean: false` on the contributor checkout so `old-results.json` survives;
- exactly two v2.5.0 direct scanner pins and one v2.5.0 reporter pin;
- absence of the superseded v2.3.8 revision and reusable-workflow delegation; and
- absence of privileged `pull_request_target` execution.

The structural contract complements, rather than replaces, hosted runtime evidence. Every changed head must still prove its own runner behavior.

## Prior OSV v2.5.0 TDD evidence

Test-only commit `4162255078be53b839b8d656b369d70939eee817` required the v2.5.0 direct scanner/reporter revision while production still used v2.3.8. Hosted Server Tests run `31938300903`, `unit-and-api` job `95143597780`, verified the exact checkout and then failed the unit contract. Production commit `21786e695c800133936032eea3f0ceaa9053c58a` changed only the scanner/reporter pins. Hosted Server Tests run `31938384438` then proved the exact head green, and OSV run `31938384547`, job `95143808626`, executed the v2.5.0 baseline/candidate comparison and SARIF upload successfully on that revision.

Those earlier results do not transfer to later heads. The live-base repair and this documentation commit require fresh exact-current-head checks before merge readiness can be assessed.

## Evidence semantics and security boundary

The repository-owned `CodeQL Required` lane does **not** publish CodeQL alerts; `upload: never` is intentional. GitHub default setup remains responsible for CodeQL alert publication. Required-context analysis and code-scanning publication are separate evidence channels.

Exact contributor-head checkout reduces evidence ambiguity; it is not code signing, artifact provenance, or a substitute for SAST, dependency review, supply-chain controls, or independent review. The named-base-ref checkout gives a current protected-base observation at workflow execution; it is not a permanent assertion that the branch will remain unchanged. Merge/release decisions must refetch the protected tip independently after all gates finish.

Neutral, skipped, cancelled, absent, stale, predecessor-head, rate-limited, model-only, status-only, or configuration-mismatch records are not promoted to passing evidence. Forked contributions must not execute untrusted contributor code in privileged `pull_request_target` context.

## Rollback and recovery

Before protected integration, rollback is source-only: remove this doctoring record, the workflow contract registration/test, the explicit Server Tests checkout/runtime assertions, the repository-owned OSV workflow, and the replacement required-context workflow together.

After protected integration, do not silently restore default pull-request checkout and then treat synthetic merge success as contributor-head evidence. Do not restore `github.event.pull_request.base.sha` and label it the current protected base. Any replacement base-sensitive workflow must preserve an independently resolved live-base identity and exact contributor-head identity.

Do not restore reusable OSV pull-request delegation unless the upstream workflow can select the intended live baseline and exact contributor head while preserving the protected-base code-scanning identity. Do not downgrade the direct OSV pins without separately evidenced vulnerability, compatibility, or rollback reason.

If CodeQL alert-publication ownership later moves from default setup back to advanced configuration, treat that as a control-plane migration and update publication authority, required contexts, regression contracts, and protected-branch evidence together.

## References

GitHub. (n.d.). *Actions checkout*. GitHub. https://github.com/actions/checkout

GitHub. (n.d.). *CodeQL Action analyze action definition*. GitHub. https://github.com/github/codeql-action/blob/main/analyze/action.yml

GitHub. (n.d.). *Configuring default setup for code scanning*. GitHub Docs. https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning

GitHub. (n.d.). *Events that trigger workflows*. GitHub Docs. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (n.d.). *Two CodeQL workflows*. GitHub Docs. https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/two-codeql-workflows

Google. (2026). *OSV-Scanner Action v2.5.0* [Source code]. GitHub. https://github.com/google/osv-scanner-action/releases/tag/v2.5.0

Google. (2026). *OSV-Scanner PR scanning reusable workflow, v2.5.0* [Source code]. GitHub. https://github.com/google/osv-scanner-action/blob/8deb546fdb875b9996d27d4950be7312dac076a1/.github/workflows/osv-scanner-reusable-pr.yml
