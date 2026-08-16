# Exact-head CI execution evidence

## Status and authority

**Status: active PR #523 evidence, not protected-`develop` shipped truth.**

This record belongs to issue #522 / PR #523. Protected `develop` remains the source of shipped truth until the exact integrated head satisfies the live ruleset, deterministic checks, security/dependency gates, resolved-review requirements, and a qualifying independent approval after the latest push.

## Buyer/control objective

A green CI badge is not defensible evidence if the job executed a different commit than the one a reviewer is asked to approve. ScopeWeave therefore separates two questions:

1. Did the exact contributor head under review execute and pass the repository-owned deterministic gates?
2. Will that immutable head satisfy the live protected-base integration and governance requirements?

GitHub documents that `pull_request` workflow runs normally expose a synthetic `refs/pull/<number>/merge` ref and that `GITHUB_SHA` is the corresponding merge commit. The official `actions/checkout` documentation separately shows that testing the pull request's head commit requires an explicit `github.event.pull_request.head.sha` checkout. Synthetic-merge success remains useful integration evidence, but it cannot substitute for contributor-head evidence under ScopeWeave's exact-head review contract.

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

## Executable regression contract

`tests/unit/workflow-exact-head-contract.test.mjs`, registered in normal `test:unit`, locks the workflow structure by requiring:

- exactly two Server Tests exact-head checkout refs and runtime expected-SHA bindings;
- `git rev-parse HEAD` verification in both Server Tests jobs;
- disabled checkout credential persistence and absence of `pull_request_target`;
- the two protected CodeQL `Analyze (...)` context names and both required languages;
- exact-head checkout and disabled credential persistence in the required CodeQL workflow;
- `upload: never` so required-context analysis coexists with GitHub default setup; and
- absence of privileged `pull_request_target` execution in the CodeQL lane.

The structural contract complements, rather than replaces, hosted runtime evidence. A syntactically plausible YAML edit still has to prove its behavior on GitHub runners.

## Hosted GREEN evidence

After removing the disabled duplicate CodeQL source, contributor head `d5b0e4caf9fcde6e8048e89773b34e19403b644a` produced successful repository-owned workflows for Server Tests, Fuzz, SAST Semgrep, OSV Scanner, Security Scan, Dependency Review, and CodeQL Required.

Server Tests run `31928621034` completed successfully. `unit-and-api` job `95119993402` and `cloud-e2e` job `95119993434` both completed their explicit checkout and `Verify exact checkout` steps successfully before their normal workloads passed.

CodeQL Required run `31928621038` also completed successfully. `Analyze (javascript-typescript)` job `95119993430` and `Analyze (python)` job `95119993473` both completed exact checkout, runtime SHA verification, CodeQL initialization, CodeQL analysis, and post-analysis steps successfully. Those job names are the exact GitHub Actions contexts required by protected `develop`.

These observations are evidence for that immutable contributor head only. Any later source, documentation, or PR-state push invalidates predecessor-head evidence for merge authority and requires a fresh exact-head sweep.

## Evidence semantics and security boundary

The repository-owned `CodeQL Required` lane does **not** claim to publish CodeQL alerts; `upload: never` is intentional. GitHub default setup remains responsible for CodeQL alert publication. Required-context analysis and code-scanning publication are separate controls with separate evidence.

Exact SHA checkout reduces evidence ambiguity; it is not code signing, artifact provenance, or a substitute for SAST, dependency review, supply-chain controls, or independent review. Forked contributions must continue to avoid executing untrusted contributor code in a privileged `pull_request_target` context.

Neutral, skipped, cancelled, absent, stale, predecessor-head, rate-limited, model-only, status-only, or configuration-mismatch records are not promoted to passing evidence. In particular, GitHub Advanced Security can emit neutral comparison records when a protected-base code-scanning configuration is not observed for a PR head; those records require separate causal investigation and are not represented here as successful gates merely because their underlying repository-native scanner workflow succeeded.

## Rollback and recovery

Before protected integration, rollback is source-only: remove this doctoring record, the workflow contract registration/test, the explicit Server Tests checkout/runtime assertions, and the replacement required-context workflow together.

After protected integration, do **not** silently restore default pull-request checkout and then treat synthetic merge success as contributor-head evidence. A replacement must preserve the invariant that the exact expected SHA is selected and verified at runtime.

Do not restore the disabled historical CodeQL workflow while default setup remains authoritative. If code-scanning ownership moves from default setup back to advanced configuration, treat that as a control-plane migration: update the alert-publication authority, required contexts, regression contract, and protected-branch evidence together and verify the resulting exact integrated head before release.

## References

GitHub. (n.d.). *Events that trigger workflows*. GitHub Docs. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (n.d.). *actions/checkout*. GitHub. https://github.com/actions/checkout

GitHub. (n.d.). *Configuring default setup for code scanning*. GitHub Docs. https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning

GitHub. (n.d.). *Two CodeQL workflows*. GitHub Docs. https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/two-codeql-workflows

GitHub. (n.d.). *CodeQL Action analyze action definition*. GitHub. https://github.com/github/codeql-action/blob/main/analyze/action.yml
