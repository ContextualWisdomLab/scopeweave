# Exact-head CI execution evidence

## Status and authority

**Status: active PR #523 evidence, not protected-`develop` shipped truth.**

This record belongs to issue #522 / PR #523. Protected `develop` remains the source of shipped truth until one unchanged integrated head satisfies the live ruleset, deterministic checks, security and dependency gates, resolved-review requirements, and a qualifying independent approval after the latest push.

## Buyer/control objective

A green CI badge is not defensible evidence if the job executed a different commit than the one a reviewer is asked to approve. ScopeWeave therefore separates two questions:

1. Did the exact contributor head under review execute and pass the repository-owned deterministic gates?
2. Will that immutable head satisfy the live protected-base integration and governance requirements?

GitHub documents that `pull_request` workflow runs normally expose a synthetic `refs/pull/<number>/merge` ref and that `GITHUB_SHA` is the corresponding merge commit. The official `actions/checkout` documentation separately shows that testing the pull request's contributor commit requires an explicit `github.event.pull_request.head.sha` checkout. Synthetic-merge success remains useful integration evidence, but it cannot substitute for contributor-head evidence under ScopeWeave's exact-head review contract.

## Server Tests root cause and RED evidence

Before this PR, both jobs in `.github/workflows/server-tests.yml` invoked the pinned `actions/checkout` action with `persist-credentials: false` but no `ref`. On a pull request, the action therefore followed the event's default synthetic merge ref.

The realistic RED regression was committed at contributor head `7c6810211a211bb0fd09c36476b5ea47c1c0af46`. Hosted Server Tests run `31924337433`, job `95109405299`, fetched and executed synthetic merge commit `120def420dec9abe154353fa699e6a69e0388268` from `refs/remotes/pull/523/merge`, whose message merged the contributor head into protected-base head `ffeffde83d62a3c0710c446a43f89aed495ae0a8`. The new contract failed because neither checkout selected the contributor head. This established the defect on the real GitHub runner rather than with a fabricated fixture.

## Server Tests narrow control

Commit `0f247d2e05fd8c9c2f69e617efd369ee7aea005d` changes both Server Tests jobs to select:

```yaml
ref: ${{ github.event.pull_request.head.sha || github.sha }}
persist-credentials: false
```

Immediately after checkout, each job binds `EXPECTED_CHECKOUT_SHA` to the same expression, runs `git rev-parse HEAD`, and fails closed if the actual SHA differs. The fallback preserves exact execution for the existing protected-`develop` push path, where there is no pull-request head.

The control deliberately keeps the unprivileged `pull_request` event, repository permissions at `contents: read`, immutable action pins, disabled credential persistence, and the existing unit/API and browser-E2E workloads. It adds no secret, token authority, merge-ref synthesis, temporary writer workflow, or bypass.

## Required CodeQL context recovery

Acceptance testing exposed a second CI-integrity defect. Protected `develop` requires the GitHub Actions contexts `Analyze (javascript-typescript)` and `Analyze (python)`, but the repository's historical `.github/workflows/codeql.yml` workflow identity (`310400876`) was disabled while GitHub CodeQL default setup was active. The source file could therefore suggest an advanced workflow existed while no current pull-request run supplied the two required contexts.

GitHub documents this control-plane behavior: enabling CodeQL default setup disables existing CodeQL workflow configurations and blocks their CodeQL analysis uploads. GitHub also states that a no-longer-used pre-existing CodeQL workflow file may be deleted after default setup becomes authoritative.

PR #523 restores the required deterministic contexts through the permanent `.github/workflows/codeql-required.yml` workflow, registered as active workflow identity `335384625`. It preserves the exact protected context names, analyzes both JavaScript/TypeScript and Python, uses the same explicit contributor-head checkout expression as Server Tests, verifies `git rev-parse HEAD`, retains `persist-credentials: false`, and remains on the unprivileged `pull_request` boundary.

The first hosted attempt on contributor head `612dcb6ed0ff17b03e30baacb301dc006bac7d6f` correctly selected and verified the contributor head, initialized CodeQL, and executed queries, but run `31928403203` failed during analysis result publication because GitHub rejected the advanced-configuration SARIF upload while default setup was enabled. This failure was treated as causal evidence rather than bypassed.

The narrow compatibility repair sets `upload: never` on the pinned `github/codeql-action/analyze` step. The CodeQL Action's own action definition documents `upload: never` as the supported way to run analysis without uploading SARIF. This keeps GitHub default setup as the repository's CodeQL alert-publication authority while the repository-owned workflow performs actual CodeQL query execution solely to provide the exact-head required-check contexts. The executable regression contract requires this separation so a future edit cannot silently reintroduce the default-setup upload conflict.

The disabled historical `.github/workflows/codeql.yml` source is removed from this PR after the replacement workflow proved active and successful. This reduces canonical-source ambiguity; it does not disable CodeQL default setup or remove the protected required contexts.

## Exact-base and exact-head OSV differential scanning

The former repository OSV lane delegated to Google's reusable pull-request workflow. That reusable workflow checks out the target branch and then checks out `$GITHUB_SHA`. On a normal `pull_request` event, `$GITHUB_SHA` is the synthetic merge commit, so upgrading only the reusable workflow would preserve immutable supply-chain pinning but would not satisfy ScopeWeave's contributor-head evidence requirement.

PR #487 correctly established that upstream tag `google/osv-scanner-action@v2.5.0` points to commit `8deb546fdb875b9996d27d4950be7312dac076a1`. Inspection of that tagged reusable workflow showed that its scanner and reporter steps are themselves pinned to direct action revision `06b2ab4348248b456ee06c9e953637f55e03504f`, annotated as v2.5.0. PR #523 preserves that unique supply-chain value without adopting the reusable workflow's synthetic-merge checkout behavior.

The repository-owned OSV `scan` job now performs the differential comparison explicitly:

1. checkout `github.event.pull_request.base.sha` with credentials disabled;
2. verify `git rev-parse HEAD` equals `EXPECTED_BASE_SHA`;
3. scan the exact base into `old-results.json` with the v2.5.0 direct scanner pin;
4. checkout `github.event.pull_request.head.sha` with credentials disabled and `clean: false` so the baseline result survives;
5. verify `git rev-parse HEAD` equals `EXPECTED_HEAD_SHA`;
6. scan the exact contributor head into `new-results.json` with the same v2.5.0 pin;
7. compare only introduced findings with the v2.5.0 reporter pin; and
8. upload the candidate-head SARIF through the repository-trusted pinned CodeQL upload action.

The job identity remains `scan`, matching the protected-base code-scanning configuration. This matters because changing only the identity to the reusable workflow's `osv-scan` produced a neutral GitHub Advanced Security comparison record stating that the protected-base `scan` configuration was not found. A neutral configuration-mismatch record is not passing security evidence.

## Executable regression contract

`tests/unit/workflow-exact-head-contract.test.mjs`, registered in normal `test:unit`, locks the workflow structure by requiring:

- exactly two Server Tests exact-head checkout refs and runtime expected-SHA bindings;
- `git rev-parse HEAD` verification in both Server Tests jobs;
- disabled checkout credential persistence and absence of `pull_request_target`;
- the two protected CodeQL `Analyze (...)` context names and both required languages;
- CodeQL exact-head checkout, runtime expected/actual SHA comparison, and disabled credential persistence;
- `upload: never` so required-context analysis coexists with GitHub default setup;
- the stable OSV `scan` job identity;
- exact immutable OSV base and contributor checkouts with runtime SHA verification;
- `clean: false` on the contributor checkout so `old-results.json` is retained;
- exactly two v2.5.0 direct scanner pins and one v2.5.0 reporter pin;
- absence of the superseded v2.3.8 OSV revision and reusable-workflow delegation; and
- absence of privileged `pull_request_target` execution in every covered lane.

The structural contract complements, rather than replaces, hosted runtime evidence. A syntactically plausible YAML edit still has to prove its behavior on GitHub runners.

## OSV v2.5.0 TDD evidence

Test-only commit `4162255078be53b839b8d656b369d70939eee817` first changed the executable contract to require the v2.5.0 direct scanner and reporter revision while the production workflow still used v2.3.8. Hosted Server Tests run `31938300903` proved RED on the exact contributor head: `unit-and-api` job `95143597780` completed checkout and `Verify exact checkout` successfully, then failed in the unit-test step; the independent browser lane remained green. This isolated the missing production pin rather than a checkout or runner failure.

Production commit `21786e695c800133936032eea3f0ceaa9053c58a` then replaced only the two scanner pins and the reporter pin with upstream v2.5.0 revision `06b2ab4348248b456ee06c9e953637f55e03504f`. Hosted Server Tests run `31938384438` proved GREEN on that exact head: `unit-and-api` job `95143808063` and `cloud-e2e` job `95143808146` both completed exact checkout verification and their full workloads successfully.

OSV run `31938384547`, job `95143808626`, also ran on exact head `21786e695c800133936032eea3f0ceaa9053c58a`. It pulled the v2.5.0 scanner image, verified both immutable checkouts, scanned both revisions, compared the results, and uploaded SARIF successfully. This is production-path evidence for that immutable code head; later documentation or metadata commits require their own exact-head gate sweep before merge authority can be claimed.

## Evidence semantics and security boundary

The repository-owned `CodeQL Required` lane does **not** claim to publish CodeQL alerts; `upload: never` is intentional. GitHub default setup remains responsible for CodeQL alert publication. Required-context analysis and code-scanning publication are separate controls with separate evidence.

Exact SHA checkout reduces evidence ambiguity; it is not code signing, artifact provenance, or a substitute for SAST, dependency review, supply-chain controls, or independent review. Forked contributions must continue to avoid executing untrusted contributor code in a privileged `pull_request_target` context.

Neutral, skipped, cancelled, absent, stale, predecessor-head, rate-limited, model-only, status-only, or configuration-mismatch records are not promoted to passing evidence. In particular, GitHub Advanced Security can emit neutral comparison records when a protected-base code-scanning configuration is not observed for a PR head; those records require separate causal investigation and are not represented here as successful gates merely because an underlying repository-native scanner workflow succeeded.

## Rollback and recovery

Before protected integration, rollback is source-only: remove this doctoring record, the workflow contract registration/test, the explicit Server Tests checkout/runtime assertions, the repository-owned exact-base/exact-head OSV workflow, and the replacement required-context workflow together.

After protected integration, do **not** silently restore default pull-request checkout and then treat synthetic merge success as contributor-head evidence. A replacement must preserve the invariant that the exact expected SHA is selected and verified at runtime.

Do not restore reusable OSV pull-request delegation unless the upstream workflow can select and attest the immutable contributor and base SHAs while preserving the protected-base code-scanning identity. Do not downgrade the direct OSV pins without a separately evidenced vulnerability, compatibility, or rollback reason.

Do not restore the disabled historical CodeQL workflow while default setup remains authoritative. If code-scanning ownership moves from default setup back to advanced configuration, treat that as a control-plane migration: update the alert-publication authority, required contexts, regression contract, and protected-branch evidence together and verify the resulting exact integrated head before release.

## References

GitHub. (n.d.). *Actions checkout*. GitHub. https://github.com/actions/checkout

GitHub. (n.d.). *CodeQL Action analyze action definition*. GitHub. https://github.com/github/codeql-action/blob/main/analyze/action.yml

GitHub. (n.d.). *Configuring default setup for code scanning*. GitHub Docs. https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning

GitHub. (n.d.). *Events that trigger workflows*. GitHub Docs. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (n.d.). *Two CodeQL workflows*. GitHub Docs. https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/two-codeql-workflows

Google. (2026). *OSV-Scanner Action v2.5.0* [Source code]. GitHub. https://github.com/google/osv-scanner-action/releases/tag/v2.5.0

Google. (2026). *OSV-Scanner PR scanning reusable workflow, v2.5.0* [Source code]. GitHub. https://github.com/google/osv-scanner-action/blob/8deb546fdb875b9996d27d4950be7312dac076a1/.github/workflows/osv-scanner-reusable-pr.yml
