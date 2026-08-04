# Hourly product-development gate

## Purpose

ScopeWeave's organization-owned workflows already inspect, repair, revalidate,
and merge pull requests more frequently than once per hour. The repository-level
workflow at `.github/workflows/hourly-product-development.yml` therefore does
**not** duplicate those privileged maintenance schedulers. It runs at minute 41
of every hour and creates one bounded product-development agent task only after
the pull-request queue and the agent-task queue are both empty.

This separates queue governance from product generation:

1. `ContextualWisdomLab/.github` owns review dispatch, feedback repair, current-
   head checks, branch updates, and policy-compliant merge behavior.
2. ScopeWeave owns the product-specific definition of commercial quality,
   realistic verification, modular architecture, standards evidence, database
   naming, and UI-design requirements.
3. A product task can create one focused pull request, but it cannot merge,
   publish, release, weaken protections, or declare itself approved.

## Schedule and single-flight behavior

The workflow runs with the cron expression `41 * * * *` and supports manual
`workflow_dispatch` for the same fail-closed gate. One repository-wide
concurrency group prevents two scheduled invocations from checking the queue at
the same time. An in-progress gate is not cancelled because interruption between
inventory and task creation could undermine duplicate prevention.

The gate checks twice:

- no open pull request exists; and
- no Copilot agent task is active or has an unknown state.

Known active states are `queued`, `in_progress`, `idle`, and
`waiting_for_user`. Known terminal states are `completed`, `failed`,
`timed_out`, and `cancelled`. Any unknown response shape, unknown task state,
non-dictionary item, API error, or missing credential keeps the gate closed.

## Credentials and permissions

The ordinary workflow token is read-only and is used only to count open pull
requests. GitHub's Agent Tasks API cannot be driven by the ordinary Actions
`GITHUB_TOKEN`; repository administrators must configure a fine-grained user
token with the necessary Agent Tasks read/write access as the
`COPILOT_GITHUB_TOKEN` repository secret.

The secret is passed only to the two steps that inventory or create agent tasks.
The workflow does not inherit all repository secrets. The generated task is
instructed to use `NVIDIA_NIM_API_KEY` only when an LLM-dependent test is truly
necessary and to access models through the provider-neutral
`contextual-orchestrator` boundary where applicable.

## Product-task contract

An eligible invocation creates exactly one task against `develop` with
`create_pull_request: true`. The prompt requires the task to:

- select one highest-impact buyer-visible Gap;
- write and observe a failing realistic test before production code;
- retain standalone operation and modular MSA extraction seams;
- require complete beginner-readable JSDoc/docstrings;
- require 100% statement, branch, function, and line coverage for changed
  production modules;
- preserve tenant isolation, bounded resources, fail-closed validation,
  determinism where applicable, and immutable audit evidence;
- use two-or-more-word `snake_case` database object names;
- use current authoritative standards or peer-reviewed evidence and record APA
  7th references under `docs/doctoring/`;
- use Figma or Product Design only for an actual buyer-facing interface and
  cover loading, empty, error, keyboard, screen-reader, touch, narrow viewport,
  and permission states;
- update CHANGELOG, migration, rollback, package, and version evidence when the
  slice is genuinely release-ready; and
- open one focused PR without self-merging or bypassing required checks.

## Failure and recovery

A scheduled run that cannot prove eligibility exits successfully with a warning
and creates no task. This avoids repeated failures when the optional agent token
is not configured while remaining fail-closed against duplicate development.
Operators should inspect the run summary for one of these expected reasons:

- open PR owns the queue;
- active or unknown agent task owns the queue;
- Agent Tasks API inventory failed or changed shape; or
- `COPILOT_GITHUB_TOKEN` is not configured.

After correcting credentials or an API contract, invoke `workflow_dispatch` to
exercise the same gate. Do not work around the inventory by deleting active task
records or weakening the terminal-state allowlist.

## Verification

`tests/config/hourly-product-development.test.mjs` statically enforces the
schedule, single-flight rules, least-privilege token boundary, duplicate
prevention, bounded prompt, database naming, coverage, documentation,
standards, Figma, LLM-provider, and no-self-merge contracts. It also rejects any
future attempt to copy the organization PR schedulers or grant repository write
permissions to this orchestration workflow.
