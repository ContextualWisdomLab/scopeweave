# Hourly commercial-readiness loop: failure RCA and realism evidence

## Scope

This record explains why a prior autonomous maintenance execution stopped without completing its intended review → repair → verification → protected merge loop, and why the replacement scheduler is operationally feasible without claiming that every hourly invocation will merge code.

## Incident symptom

The prior execution ended with an unstructured reasoning/execution failure while the requested scope included repository discovery, multiple pull requests, review systems, GitHub Checks, repair automation, product-gap development, documentation, and release decisions. No durable machine-readable checkpoint identified the exact writer target, exact head, reproduced failure, causal hypothesis, falsification test, remaining budget, or next independently executable action.

## Root-cause analysis

### Evidence

- The work surface expanded beyond a single repository writer target and combined central automation, product repositories, reviewer systems, and release concerns.
- Pull-request heads and checks could move while the execution was in progress.
- Some proposed actions depended on permissions, reviewer availability, workflow-file mutation authority, or time not proven available to the current run.
- A failed command could be retried without a required changed hypothesis, changed input, or documented transient-failure classifier.
- The scheduled-loop requirement was discussed separately from whether a repository-owned scheduler was actually merged, enabled, and provided with the required secret.

### Causal chain

1. An unbounded objective admitted too many simultaneous targets.
2. The execution lacked a one-writer target lease and strict state transition.
3. Tool failures and moving heads were not converted into durable RCA evidence.
4. Corrective actions were not required to pass a practical feasibility gate.
5. The run could therefore spend its budget exploring work that could not be safely implemented, verified, or published.
6. When the reasoning/execution budget was exhausted or an unexpected tool boundary was reached, no validated continuation state existed.

### Falsification test

The proposed cause would be disproved if an otherwise identical unbounded run—with no one-target lease, no strict RCA document, no feasibility gate, and no exact-head publication check—reliably completed repeated maintenance cycles under moving PR heads and external reviewer latency. The replacement contract therefore tests the opposite boundary directly: one target, exact identity, strict RCA JSON, practical verification and rollback, bounded time, and fail-closed publication.

## Corrective action

The repository-owned hourly workflow now requires:

- one same-repository writer target per run;
- exact head and base identity captured before model execution;
- `.opencode/rca.json` before production edits;
- evidence, causal chain, and a falsification test;
- candidate actions and one explicitly selected action;
- repository scope, writer lease, permissions, dependencies, secret-free deterministic tests, remaining time, verification commands, rollback, and external-approval feasibility checks;
- no same-command retry unless the hypothesis/input changes or the failure is classified as transient;
- one bounded transient retry at most;
- focused RED evidence before implementation and complete affected verification afterward;
- live-head revalidation immediately before publication;
- separate implementation, deterministic verification, publication, independent review, and branch-protection authorities;
- protected squash auto-merge only for non-Draft work, with no synthesized approval or bypass.

## Practical-feasibility assessment

### Feasible boundaries

- GitHub Actions can schedule an hourly workflow and serialize invocations through non-cancelling concurrency.
- A 170-minute timeout accommodates OpenCode runs that exceed one hour; subsequent hourly triggers queue rather than create competing writers.
- The model process can receive only the NVIDIA provider credential while GitHub publication occurs in a later trusted step.
- Exact-head and force-with-lease checks can prevent publication over a changed branch.
- ScopeWeave's current npm test, coverage, docstring, and Playwright contracts can verify a bounded product slice before publication.
- Review requests and protected auto-merge can be armed without granting the implementation model approval or merge authority.

### Infeasible or explicitly unclaimed boundaries

- GitHub cron is best-effort and does not guarantee execution at an exact wall-clock second.
- Missing `NVIDIA_NIM_API_KEY`, unavailable dependencies, a moving writer head, or an invalid RCA causes a fail-closed run rather than fallback to Copilot or an unreviewed model path.
- Reviewer outages, rate limits, independent-approval requirements, branch protection, and required checks can keep a verified PR open.
- A single hourly job cannot safely complete every open PR or guarantee an organization-wide zero-PR state.
- The scheduler cannot establish a USD 20 billion valuation. It can only produce auditable engineering evidence that contributes to product, security, reliability, and acquisition readiness.
- Activation is not claimed until the workflow reaches the repository's executed default-branch policy and the required NVIDIA secret is configured.

## Security and credential boundary

- `COPILOT_GITHUB_TOKEN` is prohibited as model authentication.
- `NVIDIA_NIM_API_KEY` is passed only to the isolated OpenCode process through the NVIDIA provider environment contract.
- The existing CodeRabbit, OpenCode-review, Noema, Strix, and security-review credential paths are not edited or renamed.
- Pull-request bodies, issue bodies, comments, logs, fixtures, links, and source comments are treated as untrusted evidence, not privileged instructions.
- The implementation process has no GitHub mutation token.
- The trusted publisher rechecks the live head and removes `.opencode` evidence from the source commit.
- Credentials, raw tokens, sensitive payloads, and model outputs containing secrets must not enter commits, URLs, comments, fixtures, audit events, or retained artifacts.

## Failure handling

| Failure | Required response |
| --- | --- |
| Deterministic test or contract failure | Inspect the first causal error, strengthen/reproduce RED evidence, implement the smallest repair, rerun focused then full gates |
| Documented transient infrastructure failure | Permit at most one bounded retry and record classifier plus retry outcome |
| Moving pull-request head | Publish nothing; preserve evidence and let a later run recapture the new exact head |
| Unrealistic action | Make no production edit; record the failed realism field and select another independent target in a later invocation |
| Missing NVIDIA secret | Fail closed; never fall back to Copilot or GitHub Models |
| Reviewer/check latency | Do not treat as success; continue analysis of a separate target in a later invocation |
| Protection rejection | Keep the PR open or auto-merge armed; never bypass or synthesize approval |

## Verification evidence required before activation

1. The permanent contract job passes on the exact pull-request head.
2. The workflow and prompt contain the hourly cadence, non-cancelling concurrency, NVIDIA-only provider boundary, RCA validator, exact-head writer lease, protected-path guard, deterministic test contract, and protected auto-merge boundary.
3. Unit tests cover accepted RCA evidence and failure of missing permissions, unavailable dependencies, time overruns, missing verification, absent rollback, external implementation approval, malformed SHA, unknown fields, and malformed JSON.
4. Repository-required security and review gates complete on the exact head.
5. A manual `workflow_dispatch` canary is executed only after merge; the canary must not publish a release.

## Rollback

Revert `.github/workflows/hourly-opencode-commercial-readiness.yml` and its assignment/contract files. No database object, runtime migration, user data, or release artifact depends on this automation. Existing manual maintenance, reviewers, branch protection, and ordinary repository workflows remain available.

## Standards and primary references

GitHub. (2026). *Control the concurrency of workflows and jobs*. GitHub Docs. https://docs.github.com/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency

GitHub. (2026). *Events that trigger workflows*. GitHub Docs. https://docs.github.com/actions/using-workflows/events-that-trigger-workflows

GitHub. (2026). *Security hardening for GitHub Actions*. GitHub Docs. https://docs.github.com/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions

GitHub. (2026). *Workflow syntax for GitHub Actions*. GitHub Docs. https://docs.github.com/actions/writing-workflows/workflow-syntax-for-github-actions

National Institute of Standards and Technology. (2022). *Secure software development framework (SSDF) version 1.1: Recommendations for mitigating the risk of software vulnerabilities* (NIST SP 800-218). https://doi.org/10.6028/NIST.SP.800-218

NVIDIA. (2026). *NVIDIA NIM APIs*. NVIDIA Documentation. https://docs.nvidia.com/nim/

OpenCode. (2026). *CLI and provider configuration*. https://opencode.ai/docs/
