# Hourly OpenCode commercial-readiness loop: evidence and design record

## Decision

ScopeWeave separates two autonomous responsibilities:

1. organization-owned workflows review, repair, revalidate, and merge existing
   pull requests under the repository rules; and
2. one repository-owned scheduled workflow may create a new product-development
   pull request only when the open pull-request queue is empty.

The product-development workflow runs OpenCode directly inside GitHub Actions and
uses the organization secret named `NVIDIA_NIM_API_KEY`. It does not create a
GitHub Copilot Agent Task, require a Copilot subscription, or use a fine-grained
user token. The OpenCode process receives the NVIDIA key but no GitHub mutation
credential. A later trusted shell step performs the commit, branch push, and pull
request creation only after deterministic verification and a second queue check.

This boundary preserves the existing CodeRabbit, Noema, OpenCode-review, Strix,
and central merge-scheduler identities. The new workflow neither copies those
reviewers nor changes their keys, permissions, or approval semantics.

## Authoritative platform and provider constraints

OpenCode documents custom OpenAI-compatible providers through an explicit
provider identifier, the `@ai-sdk/openai-compatible` package, a `baseURL`, an
explicit model map, and an environment-derived API key. ScopeWeave follows that
contract for the NVIDIA hosted endpoint rather than embedding a credential or
adding a repository-specific provider client.

NVIDIA documents NIM for large language models as an OpenAI-compatible inference
API. NVIDIA's hosted endpoint uses `https://integrate.api.nvidia.com/v1`, and the
API key is conventionally provided through `NVIDIA_API_KEY`. The workflow maps
the GitHub secret `NVIDIA_NIM_API_KEY` to that process-only environment variable.

GitHub scheduled workflows execute from the latest commit on the default branch.
The hourly loop therefore remains inert until this workflow is reviewed and
merged into `develop`. GitHub also permits scheduled runs to be delayed or
omitted under load, so the design treats the schedule as a best-effort heartbeat,
not as a durable clock or service-level guarantee.

GitHub recommends explicit least-privilege token permissions. The workflow-level
token is read-only. The job receives repository-content and pull-request write
permissions only because the trusted publication step must create one branch and
one pull request. The OpenCode command explicitly removes `GH_TOKEN`,
`GITHUB_TOKEN`, repository-token variables, and OIDC request variables from its
environment. The NVIDIA secret is scoped only to the gate and OpenCode steps and
is absent during dependency installation and test execution.

## Supply-chain and execution controls

OpenCode is installed from one explicit release archive. The workflow pins both
the release version and a SHA-256 digest and verifies the downloaded archive
before installation. It does not install `latest`, execute an unverified install
script, or allow a pull request to select the agent binary.

The coding-agent process may edit the checked-out repository but may not commit,
push, open a pull request, merge, publish, or release. A post-agent boundary
rejects:

- changes to review-agent and security-review workflows;
- changes to `.trivyignore`, `.semgrepignore`, or `.gitleaksignore`;
- credential-like GitHub or NVIDIA token literals;
- commits created by the agent; and
- whitespace or conflict-marker errors detected by `git diff --check`.

The workflow then runs `npm ci`, all unit and API tests, coverage, the configured
docstring evidence gate, cloud browser E2E when available, and a final diff
check. Publication occurs only after these commands succeed. Current-head GitHub
Checks and independent reviews remain separate protected-branch evidence; a
successful local workflow run does not approve or merge its own pull request.

## Single-flight and race handling

The first gate fails closed when pull-request inventory is unavailable, when an
open pull request exists, or when the NVIDIA secret is absent. One repository-wide
non-cancelling concurrency group prevents two scheduled agents from running at
the same time.

The workflow checks the open pull-request queue again immediately before branch
publication. If another actor created a pull request while the model was working,
the trusted publisher discards publication for that hour. GitHub does not expose
a repository-wide compare-and-create transaction for pull requests, so this does
not claim global atomicity against unrelated clients. Repository operators must
keep this workflow as the sole scheduled product-development producer.

## Product-quality contract

The assignment limits each run to one buyer-visible vertical slice. It requires:

- red-green-refactor test-first development;
- realistic multi-tenant, concurrency, failure, migration, recovery, scale, and
  accessibility cases appropriate to the selected feature;
- 100% statement, branch, function, and line coverage for new or materially
  changed production modules;
- complete beginner-readable JSDoc or docstrings;
- descriptive two-word-or-longer `snake_case` database objects;
- standalone operation and replaceable MSA adapters;
- `contextual-orchestrator` for any product LLM path;
- deterministic validation of model output before persistence;
- APA 7th standards or peer-reviewed evidence in `docs/doctoring/`;
- Figma or Product Design only for genuine buyer-facing interaction work; and
- CHANGELOG, operations, security, migration, rollback, and release evidence
  updates when relevant.

The prompt explicitly prohibits security suppression, branch-protection changes,
self-merge, self-release, and unrelated refactoring. The model must leave a
working-tree change and a `PR_MESSAGE.md`; a trusted step packages that output as
one pull request against `develop`.

## Verification contract

The repository contract test must prove that the workflow:

- runs hourly with non-cancelling single-flight concurrency;
- fails closed when a pull request exists or the NVIDIA secret is unavailable;
- contains no Copilot Agent Tasks endpoint or `COPILOT_GITHUB_TOKEN`;
- pins and verifies the OpenCode binary;
- uses the OpenAI-compatible NVIDIA endpoint and an environment key;
- strips GitHub mutation credentials from OpenCode;
- blocks reviewer-workflow and scanner-suppression changes;
- performs the complete deterministic verification sequence before publication;
- rechecks the pull-request queue before publishing; and
- leaves independent review, exact-head Checks, and merge authority with central
  governance.

The first live scheduled run additionally provides operational evidence that the
configured OpenCode release, NVIDIA model pool, and repository secret work in the
actual GitHub-hosted environment. Until that run succeeds, the workflow is
implemented and statically verified but not yet operationally proven.

## Limitations

The NVIDIA hosted model catalog can change independently of the repository. A
candidate-model failure causes the workflow to discard partial work and try the
next pinned model identifier. Failure of every candidate produces no pull
request. The model pool and OpenCode release should be updated only through a
reviewed pull request with current documentation and checksum evidence.

The hourly schedule is not a durable job queue. Missed ticks, GitHub Actions
capacity, NVIDIA service availability, repository billing policy, or secret
rotation can postpone a run. The workflow deliberately fails closed instead of
creating overlapping or unverifiable work.

## References

Anomaly. (2026). *Providers*. OpenCode documentation.
https://opencode.ai/docs/providers

GitHub. (2026a). *Events that trigger workflows*. GitHub Docs.
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (2026b). *Security hardening for GitHub Actions*. GitHub Docs.
https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions

GitHub. (2026c). *Workflow syntax for GitHub Actions*. GitHub Docs.
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax

NVIDIA Corporation. (2026). *API reference: NVIDIA NIM for large language
models*. NVIDIA Documentation.
https://docs.nvidia.com/nim/large-language-models/2.0.1/reference/api-reference.html
