# Exact-head CodeQL evidence binding

## Status

Implemented on active PR only until the change reaches protected `develop`.

## Problem

ScopeWeave's repository-owned CodeQL workflow used the default `actions/checkout` ref. For a workflow triggered by `pull_request`, GitHub binds the default source revision to the pull request merge ref and exposes the synthetic merge commit through `GITHUB_SHA`.

The protected branch rules require the two repository CodeQL contexts, `Analyze (javascript-typescript)` and `Analyze (python)`. Treating those checks as exact-head security evidence while their database was initialized from a synthetic merge revision creates the same evidence-authority mismatch already repaired in the repository-owned fuzz and OSV lanes.

This is a ScopeWeave workflow-integrity defect, not a source vulnerability and not a reason to weaken CodeQL or branch protection.

## Decision

Before CodeQL initialization, `.github/workflows/codeql.yml` now:

1. checks out `${{ github.event.pull_request.head.sha || github.sha }}` explicitly;
2. retains `persist-credentials: false`;
3. records the same expression as `EXPECTED_SHA`;
4. compares `git rev-parse HEAD` with that immutable expected revision; and
5. fails closed before `github/codeql-action/init` when the identities differ.

For protected push and scheduled execution, the fallback remains the event's exact `github.sha`. The CodeQL language matrix, action revisions, categories, and permissions remain unchanged.

## Test-first evidence

Test-only commit `9ecccb04ab36d6687cd87c83dd72343227415908` strengthened `tests/unit/coverage-script-contract.test.mjs` while the production CodeQL workflow still used default checkout behavior. The regression requires explicit source ref selection and attestation before CodeQL initialization.

The immediate production repair superseded the hosted Server Tests run for that test-only head before it completed, so cancelled predecessor evidence is not promoted as executed RED proof. The source-ordering remains test-first: the executable contract was committed before the workflow repair.

Production commit `e9385e4ad5c3249fec13272d9831cc0b263fe02e` implements the narrow exact-checkout and pre-initialization attestation. Fresh exact-current-head repository and organization evidence must pass after this documentation commit; predecessor CodeQL results do not transfer.

## Verification contract

Before integration:

- the workflow contract must pass under `unit-and-api`;
- both CodeQL matrix jobs must run against the exact current contributor head on the pull request;
- the SHA attestation must execute before CodeQL initialization;
- no workflow permission is broadened;
- exact-head review/security evidence remains separate from synthetic mergeability evidence; and
- any contributor-head or protected-base movement invalidates head/base-sensitive conclusions and triggers fresh evidence.

## Rollback

Do not restore default merge-ref checkout merely to make a required CodeQL status green. A verified action/runtime compatibility problem should be repaired while keeping explicit source identity and fail-closed attestation intact.

## References

GitHub. (n.d.). *Events that trigger workflows*. GitHub Docs. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (n.d.). *Variables reference*. GitHub Docs. https://docs.github.com/en/actions/reference/workflows-and-actions/variables

GitHub. (n.d.). *Configuring default setup for code scanning*. GitHub Docs. https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning

GitHub. (2026). *CodeQL Action* [Source code]. GitHub. https://github.com/github/codeql-action
