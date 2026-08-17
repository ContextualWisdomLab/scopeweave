# Exact-head OSV evidence binding

## Status

Implemented on active PR only until the change reaches protected `develop`.

## Problem

ScopeWeave's repository-owned `OSV Scanner` wrapper delegated pull-request scanning to the pinned `google/osv-scanner-action` reusable PR workflow. That upstream workflow checks out the target branch for the old-code scan and then checks out `$GITHUB_SHA` for the new-code scan.

For a workflow triggered by `pull_request`, GitHub defines `GITHUB_SHA` as the pull request's synthetic merge commit rather than the contributor branch head. A green reusable-workflow result therefore proved that OSV scanned a merge synthesis, not necessarily the unchanged contributor SHA used for review and release decisions.

The same evidence path also relied on the reusable workflow's branch checkout for its old-code comparison. ScopeWeave's governance contract distinguishes a pull request's historical base snapshot from the independently resolved current protected-base tip, so the repository-owned wrapper must bind both identities explicitly.

This is an evidence-integrity defect in ScopeWeave's wrapper, not a vulnerability in application source and not a reason to patch the upstream OSV Scanner project.

## Decision

Keep the immutable OSV Scanner action/reporter revisions, scan arguments, SARIF upload, and existing `fail-on-vuln=false` companion-SCA policy, but own the revision-selection steps locally in `.github/workflows/osvscanner.yml`.

For every pull-request run the workflow now:

1. reads the exact contributor SHA from `github.event.pull_request.head.sha`;
2. reads the protected base branch name from `github.event.pull_request.base.ref`;
3. checks out and attests the exact contributor SHA;
4. independently fetches the current protected base ref and resolves its live commit;
5. checks out and attests that live base before creating `old-results.json`;
6. checks out and attests the exact contributor SHA again before creating `new-results.json`;
7. compares those two explicit results with the pinned OSV reporter; and
8. uploads bounded SARIF and JSON evidence without persisting checkout credentials.

The workflow remains on `pull_request`, not `pull_request_target`, and does not materialize repository secrets or broaden application authority.

## Test-first evidence

Test-only commit `d2546ca5831155c0f28a99ba4b46dcb6a4643431` strengthened `tests/unit/coverage-script-contract.test.mjs` before the OSV workflow changed. The contract rejected delegation to `osv-scanner-reusable-pr.yml` and required explicit exact-head and live-base resolution/attestation.

Hosted Server Tests run `32021071089` then failed on that test-only head while the production OSV wrapper still delegated revision selection to the reusable workflow. This is the executed RED evidence for the defect.

Production commit `5ab1ad88fce00c4b8279f40170d7280f64e46120` replaced only the repository-owned OSV wrapper's revision-selection/orchestration layer. Exact-current-head GREEN evidence must be regenerated after this documentation commit; predecessor runs do not authorize integration.

## Security and failure contract

- Invalid contributor SHA or base ref fails closed before scanning.
- A checkout that does not resolve to the expected immutable SHA fails closed.
- The live protected base is independently fetched immediately before the old-code scan.
- Scanner exit status remains input to the pinned reporter; scanner execution is not replaced with a synthetic success path.
- OSV evidence remains a companion SCA lane. Central organization security/review gates retain their separate authority.
- No credentials, tokens, provider payloads, or customer data are added to logs or artifacts by this repair.
- A later upstream reusable-workflow revision may be reconsidered only if its exact-head/live-base semantics are explicitly compatible with ScopeWeave's evidence contract.

## Rollback

Do not restore the old reusable PR workflow merely to obtain a green status. If the local orchestration exposes a verified incompatibility, keep exact identity binding fail-closed and repair the smallest affected checkout/scanner/reporter step while preserving the immutable action pins and evidence identities.

## References

GitHub. (n.d.). *Events that trigger workflows*. GitHub Docs. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (n.d.). *Variables reference*. GitHub Docs. https://docs.github.com/en/actions/reference/workflows-and-actions/variables

Google LLC. (2026). *OSV-Scanner PR scanning reusable workflow (`3a7550f43ba5b58905a821ce3a0ed24c4858b3f4`)* [Source code]. GitHub. https://github.com/google/osv-scanner-action/blob/3a7550f43ba5b58905a821ce3a0ed24c4858b3f4/.github/workflows/osv-scanner-reusable-pr.yml

Google LLC. (2026). *OSV-Scanner GitHub Action* [Source code]. GitHub. https://github.com/google/osv-scanner-action
