# Hourly OpenCode Commercial-Readiness Loop

## Purpose

ScopeWeave uses one bounded GitHub Actions schedule to keep protected pull requests moving and to start the next buyer-visible product slice when the pull-request queue reaches zero. The schedule runs OpenCode with an NVIDIA NIM model through `NVIDIA_NIM_API_KEY`; it does not invoke GitHub Copilot. Existing CodeRabbit, Noema, OpenCode-review, Strix, and security-review workflows retain their own credentials, source pins, review semantics, and branch-protection authority.

The loop is intentionally a thin product-repository module. ScopeWeave remains fully operable without the schedule, while the same execution contract can later be moved into `ContextualWisdomLab/.github` and called by ScopeWeave, naruon, or another service at an immutable reusable-workflow commit.

## Hourly state machine

The workflow runs at minute 17 of every hour and processes at most one bounded target.

1. **Select a trusted target.** Ready pull requests are considered before Draft pull requests. A target must use a branch in the ScopeWeave repository and must be authored by an organization owner, member, collaborator, or an explicitly trusted dependency automation account. Fork code is not selected.
2. **Capture evidence.** The workflow records pull-request metadata, status checks, top-level reviews, comments, changed files, and unresolved inline review threads in an ephemeral runner directory. When the queue is empty, it records the open product issues instead.
3. **Develop with OpenCode and NVIDIA NIM.** OpenCode receives the bounded assignment and the captured evidence. The model is instructed to use strict red-green-refactor TDD, realistic product tests, complete beginner-readable JSDoc, multi-word `snake_case` database objects, APA 7th documentation, and framework-independent module seams.
4. **Enforce static trust boundaries.** The workflow rejects history rewrites, whitespace errors, credential-like literals, `pull_request_target`, submodule trust changes, self-modification, and changes to existing review-agent workflows.
5. **Run the complete product gate.** Dependency installation and production audit, lint and type checking when configured, unit tests, API tests, coverage, docstring evidence, optional cloud E2E, and `git diff --check` must pass.
6. **Publish without the model credential.** Only the publication step receives `GH_TOKEN`. It refuses to push if an existing pull-request head moved during the run. New product work is opened as Draft. Existing Ready work is submitted only to protected squash auto-merge.
7. **Request exact-head review.** A head-specific marker prevents duplicate review comments. Repository and organization-required checks, unresolved-thread rules, and independent reviews remain authoritative.

## Credential and execution separation

The job has the minimum write permissions needed by the final publication step, but credentials are not exported globally.

- `NVIDIA_NIM_API_KEY` is exported only to the OpenCode execution step.
- `GH_TOKEN` is exported only to GitHub-reading steps and the final publication/review steps; it is not exported to OpenCode or product-test processes.
- `actions/checkout` uses `persist-credentials: false`, so the model and test processes do not inherit a credential-bearing Git remote.
- The NIM provider configuration refers to `{env:NVIDIA_NIM_API_KEY}` rather than serializing the secret.
- Raw OpenCode output is never printed or uploaded. If the output contains the exact model credential, it is destroyed and the run fails.
- The publication remote is restored with a shell trap, and GitHub masks the token before it is used.

This separation reduces accidental disclosure, but it is not a sandbox equivalent. The workflow therefore selects only same-repository trusted branches, forbids environment enumeration in the assignment, and revalidates every changed path and added line before any remote write.

## Configuration

| Name | Kind | Default | Contract |
|---|---|---|---|
| `NVIDIA_NIM_API_KEY` | GitHub Actions secret | None | Required only by the OpenCode step. Must never be copied into repository files, logs, issue comments, URLs, or artifacts. |
| `OPENCODE_NIM_MODEL` | Repository variable | `qwen/qwen3-coder-480b-a35b-instruct` | Provider model identifier containing only letters, digits, period, underscore, slash, and hyphen. |
| `OPENCODE_VERSION` | Repository variable | `latest` | `latest` resolves one registry version per run; an explicit semantic version provides reproducible installation. The resolved version and registry integrity are written to the job summary. |

Production operators should pin `OPENCODE_VERSION` after accepting a release and periodically advance the pin through a reviewed pull request. `latest` is retained as a bootstrap default so a newly installed schedule is functional before repository variables are provisioned.

## Review-agent non-interference contract

The scheduled implementation agent may not change a workflow whose path identifies CodeRabbit, Noema, OpenCode-review, a generic review agent, Strix, or security review. It may not rewrite the hourly workflow itself. The workflow also does not create status checks, submit independent approvals, dismiss reviews, mark Draft pull requests Ready, alter branch protection, or invoke administrator merge.

OpenCode's implementation result is therefore evidence for the ordinary protected review pipeline, not a substitute for it.

## Product-quality contract

A product change produced by the loop must meet the same standard as a manually developed change:

- realistic behavioral tests rather than mock-only coverage;
- 100% statement, branch, function, and line coverage for new or materially changed production modules;
- complete JSDoc for public and security-sensitive behavior;
- descriptive multi-word `snake_case` database objects;
- explicit privacy, tenant, authorization, concurrency, failure, recovery, and performance boundaries;
- current authoritative standards or peer-reviewed research with APA 7th references;
- `CHANGELOG.md` updates;
- no skipped or weakened acceptance tests;
- no version or release publication until the protected exact head is independently accepted.

LLM-dependent product tests must consume `NVIDIA_NIM_API_KEY` through the repository's established contextual-orchestrator seam. The hourly agent may repair contextual-orchestrator integration problems encountered by the selected product slice, but it may not change the independent review-agent key system.

## Failure behavior

The loop fails closed when:

- no model credential is configured;
- the selected branch is a fork or has an untrusted author association;
- OpenCode fails before its bounded deadline;
- raw model output contains the model credential;
- the agent rewrites history or changes a protected workflow;
- the diff contains a credential-like literal, private key, or `pull_request_target` addition;
- dependency, test, coverage, docstring, E2E, audit, or whitespace verification fails;
- the remote pull-request head moves during development;
- the queue is empty and the agent produces no verified product change.

A failed run never publishes a partial patch and never converts a Draft pull request to Ready.

## Modularity and future centralization

The product repository owns target selection and product tests. OpenCode provider configuration, credential separation, static policy checks, and protected publication form a reusable orchestration module. A future central workflow can expose these as versioned inputs while leaving ScopeWeave-specific commands and acceptance tests in a thin caller. This preserves independent operation and supports composition into the CWL/naruon MSA ecosystem without copying review-agent implementations.

## References

GitHub, Inc. (n.d.). *Security hardening for GitHub Actions*. GitHub Docs. Retrieved August 4, 2026, from https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions

International Organization for Standardization. (2023). *Information technology—Artificial intelligence—Management system* (ISO/IEC Standard No. 42001:2023). https://www.iso.org/standard/81230.html

National Institute of Standards and Technology. (2022). *Secure software development framework (SSDF) version 1.1: Recommendations for mitigating the risk of software vulnerabilities* (NIST Special Publication 800-218). https://doi.org/10.6028/NIST.SP.800-218

National Institute of Standards and Technology. (2024). *Artificial intelligence risk management framework: Generative artificial intelligence profile* (NIST AI 600-1). https://doi.org/10.6028/NIST.AI.600-1

NVIDIA Corporation. (n.d.). *NVIDIA NIM APIs*. NVIDIA API Catalog. Retrieved August 4, 2026, from https://build.nvidia.com/explore/discover

OpenCode. (n.d.). *Providers*. Retrieved August 4, 2026, from https://opencode.ai/docs/providers/

OWASP Foundation. (2025). *OWASP Top 10 for large language model applications 2025*. https://genai.owasp.org/llm-top-10/
