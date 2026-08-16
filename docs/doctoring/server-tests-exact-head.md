# Server Tests exact-head execution evidence

## Status and authority

**Status: active PR #523 evidence, not protected-`develop` shipped truth.**

This record belongs to issue #522 / PR #523. Protected `develop` remains the source of shipped truth until the exact integrated head satisfies the live ruleset, deterministic checks, security/dependency gates, resolved-review requirements, and a qualifying independent approval after the latest push.

## Buyer/control objective

A green CI badge is not defensible evidence if the job executed a different commit than the one a reviewer is asked to approve. For ScopeWeave, repository-native `Server Tests` must answer a precise question: **did the exact contributor head under review execute and pass?**

GitHub documents that `pull_request` workflow runs normally expose a synthetic `refs/pull/<number>/merge` ref and that `GITHUB_SHA` is the corresponding merge commit. The official `actions/checkout` documentation separately shows that testing the pull request's head commit requires an explicit `github.event.pull_request.head.sha` checkout. Those semantics matter because synthetic-merge success is useful integration evidence but cannot substitute for contributor-head evidence under ScopeWeave's exact-head review contract.

## Root cause and RED evidence

Before this PR, both jobs in `.github/workflows/server-tests.yml` invoked the pinned `actions/checkout` action with `persist-credentials: false` but no `ref`. On a pull request, the action therefore followed the event's default synthetic merge ref.

The realistic RED regression was committed at contributor head `7c6810211a211bb0fd09c36476b5ea47c1c0af46`. Hosted Server Tests run `31924337433`, job `95109405299`, then fetched and executed synthetic merge commit `120def420dec9abe154353fa699e6a69e0388268` from `refs/remotes/pull/523/merge`, whose message merged the contributor head into protected-base head `ffeffde83d62a3c0710c446a43f89aed495ae0a8`. The new contract failed because neither checkout selected the contributor head. This established the defect on the real GitHub runner rather than with a fabricated fixture.

## Narrow control

Commit `0f247d2e05fd8c9c2f69e617efd369ee7aea005d` changes both Server Tests jobs to select:

```yaml
ref: ${{ github.event.pull_request.head.sha || github.sha }}
persist-credentials: false
```

Immediately after checkout, each job binds `EXPECTED_CHECKOUT_SHA` to the same expression, runs `git rev-parse HEAD`, and fails closed if the actual SHA differs. The fallback preserves exact execution for the existing protected-`develop` push path, where there is no pull-request head.

The control deliberately keeps:

- the unprivileged `pull_request` event rather than `pull_request_target`;
- repository permissions at `contents: read`;
- immutable action pins already used by the workflow;
- `persist-credentials: false` in both checkout steps;
- the existing unit/API and browser-E2E workload.

It adds no secret, token permission, merge-ref synthesis, temporary writer workflow, or bypass.

## Executable regression contract

`tests/unit/workflow-exact-head-contract.test.mjs`, registered in normal `test:unit`, locks the workflow structure by requiring:

- exactly two explicit exact-head checkout refs;
- exactly two expected-SHA runtime bindings;
- an actual `git rev-parse HEAD` verification in both jobs;
- credential persistence to remain disabled in both jobs; and
- absence of `pull_request_target`.

The structural contract complements, rather than replaces, hosted runtime evidence. A syntactically plausible YAML edit still has to prove its behavior on the GitHub runner.

## GREEN exact-head evidence

Hosted Server Tests run `31924375779` executed current contributor head `0f247d2e05fd8c9c2f69e617efd369ee7aea005d`.

For `unit-and-api` job `95109501030`, the runner log shows the checkout action received `ref: 0f247d2e05fd8c9c2f69e617efd369ee7aea005d`, fetched that SHA directly, checked out that SHA, reported the same value from `git log -1 --format=%H`, and passed the runtime expected-SHA assertion. The normal unit suite then passed the new `Server Tests exact-head workflow contract`; API and eval-safety steps also passed.

For `cloud-e2e` job `95109500953`, the log independently shows the same explicit ref, direct SHA fetch and checkout, exact `git log` result, and successful runtime assertion. The browser workload executed `tests/e2e/cloud.spec.js` and passed all 9 tests.

The run concluded successfully for both jobs. Separate current-head Dependency Review, Fuzz, Security Scan, OSV Scanner, and SAST Semgrep workflow runs also completed successfully on this contributor head. This does **not** promote neutral/skipped/absent or configuration-mismatch security evidence to passing status, does not manufacture independent review, and does not claim merge readiness.

## Evidence semantics

This change intentionally separates two questions:

1. **Contributor-head question:** did the exact immutable source a reviewer sees pass repository tests? This PR fixes and proves that evidence path.
2. **Integration question:** will that head still satisfy all requirements when integrated with the live protected base? That remains a separate live-base/ruleset obligation before merge.

A future workflow may add explicit merge-compatibility evidence, but it must not replace or obscure exact-head evidence. After any contributor-head movement, all predecessor runs and approvals are historical.

## Security and supply-chain boundary

Exact SHA checkout reduces evidence ambiguity; it is not code-signing, artifact provenance, or a substitute for SAST/dependency/review controls. The workflow keeps deterministic tests independent of model judgment and retains read-only token authority. Any future use of forked contributions must continue to avoid executing untrusted head code in a privileged `pull_request_target` context.

The change does not alter release, package, SBOM, provenance, branch-protection, or review authority. Those gates remain independently required where applicable.

## Rollback and recovery

Before protected integration, rollback is source-only: remove this doctoring record, the workflow contract registration/test, and the explicit checkout/runtime assertion together.

After protected integration, do **not** silently restore default pull-request checkout and then treat synthetic merge success as contributor-head evidence. A replacement must preserve the invariant that the exact expected SHA is selected and verified at runtime, with separate integration evidence if desired.

## References

GitHub. (n.d.). *Events that trigger workflows*. GitHub Docs. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (n.d.). *actions/checkout*. GitHub. https://github.com/actions/checkout
