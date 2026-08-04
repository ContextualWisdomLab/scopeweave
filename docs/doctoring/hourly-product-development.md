# Hourly product-development orchestration: evidence and design record

## Decision

ScopeWeave separates privileged pull-request maintenance from product-task
creation. Organization-central workflows own review dispatch, feedback repair,
exact-head checks, branch updates, and policy-compliant merge behavior. The
repository-level hourly gate creates one development task only after it proves
that no pull request and no active or unknown agent task owns the queue.

This boundary prevents three failure modes:

1. duplicated repository and organization PR schedulers consuming the same
   Actions and reviewer capacity;
2. overlapping coding agents creating competing pull requests for the same
   buyer Gap; and
3. an orchestration token receiving repository write permissions that it does
   not require.

## Authoritative platform constraints

GitHub documents the Agent Tasks API as a public-preview interface that can
create, list, and inspect Copilot cloud-agent tasks. The API accepts
`base_ref` and `create_pull_request`, but supports user-to-server credentials
rather than the ordinary workflow `GITHUB_TOKEN`. ScopeWeave therefore uses a
separately scoped `COPILOT_GITHUB_TOKEN`, inventories tasks before creation,
and fails closed when the credential, API call, response shape, or task state
cannot be trusted. The current Agent Tasks endpoint examples explicitly send
`X-GitHub-Api-Version: 2022-11-28`; the workflow follows that endpoint-specific
documented contract instead of opting the preview integration into the newer
general REST version without endpoint evidence.

GitHub scheduled workflows execute from the latest commit on the default branch.
Consequently, the hourly gate does not become active merely because its pull
request exists: the workflow must first pass protected-branch review and merge
into `develop`.

GitHub Actions concurrency groups prevent multiple runs with the same key from
running simultaneously. ScopeWeave uses one repository-wide group and sets
`cancel-in-progress: false` so a later hourly tick cannot interrupt a running
inventory between the first and second duplicate-prevention checks. Because
GitHub may replace an older pending run, the workflow does not depend on strict
cron ordering or on every scheduled tick being executed.

GitHub's workflow-security guidance recommends explicit minimum permissions.
The hourly workflow declares only read access to repository contents and pull
requests. It does not run a third-party action, inherit all secrets, or grant
write access through `GITHUB_TOKEN`; the user token is exposed only to the two
Agent Tasks API steps.

## Fail-closed task inventory

The gate recognizes these active states:

- `queued`
- `in_progress`
- `idle`
- `waiting_for_user`

It recognizes only these terminal states:

- `completed`
- `failed`
- `timed_out`
- `cancelled`

Every unknown state, non-object entry, unsupported pagination shape, parse
failure, HTTP failure, missing token, or open PR is treated as ownership of the
queue. A second inventory immediately before creation narrows the race window.
The API does not expose a repository-level compare-and-create primitive in the
documented public-preview contract, so the workflow does not claim globally
atomic task creation against unrelated external clients. Repository operators
must use this workflow as the single scheduled producer.

## Development contract

The task prompt is a merge gate rather than a marketing statement. It requires
one bounded buyer-visible vertical slice, failing-test-first development,
realistic customer and failure cases, standalone and modular MSA operation,
provider-neutral adapters, two-or-more-word `snake_case` database objects,
complete JSDoc/docstrings, and 100% statement, branch, function, and line
coverage for changed production modules.

Material decisions require current authoritative standards or peer-reviewed
evidence recorded with APA 7th references under `docs/doctoring/`. LLM-dependent
tests are optional rather than default; when necessary they use the repository's
`NVIDIA_NIM_API_KEY` through the `contextual-orchestrator` seam, while
deterministic tests remain required. Figma or Product Design is required only
when the selected slice includes an actual buyer-facing interface.

The generated task must open one focused pull request and is expressly forbidden
from merging itself, publishing a release, weakening branch protection, or
bypassing checks and independent review.

## Verification contract

`tests/config/hourly-product-development.test.mjs` statically proves:

- the hourly schedule and manual entry point;
- one non-cancelling concurrency group;
- read-only repository permissions;
- absence of central PR-scheduler duplication;
- required user-token, documented API-version, and Agent Tasks API boundaries;
- open-PR and active/unknown-task rejection;
- one reviewable pull request per eligible task;
- coverage, documentation, database naming, realistic testing, standards,
  Figma, LLM-provider, and no-self-merge prompt requirements; and
- absence of broad secret inheritance or repository write permissions.

After merge, an operator must exercise `workflow_dispatch` once with no open PR
and a controlled terminal task inventory, confirm exactly one task is created,
then repeat with that task active and confirm no second task is created. The
production schedule remains fail-closed until `COPILOT_GITHUB_TOKEN` is
configured with the documented user-to-server Agent Tasks permissions.

## References

GitHub. (n.d.-a). *Concurrency*. GitHub Docs. Retrieved August 4, 2026, from
https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency

GitHub. (n.d.-b). *Events that trigger workflows*. GitHub Docs. Retrieved August
4, 2026, from
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (n.d.-c). *Protecting against security threats*. GitHub Docs. Retrieved
August 4, 2026, from
https://docs.github.com/en/code-security/tutorials/secure-your-organization/protect-against-threats

GitHub. (n.d.-d). *Using Copilot cloud agent via the API*. GitHub Docs.
Retrieved August 4, 2026, from
https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api
