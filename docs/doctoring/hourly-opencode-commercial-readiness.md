# Hourly OpenCode commercial-readiness loop: evidence and design record

## Decision

ScopeWeave separates autonomous work into two bounded systems:

1. organization-owned workflows review, repair, revalidate, and merge existing
   pull requests under repository rules; and
2. one repository-owned hourly workflow may propose a new product-development
   pull request only when the open pull-request queue is empty.

The repository workflow runs the OpenCode CLI against NVIDIA hosted NIM models
with `NVIDIA_NIM_API_KEY`. It does not call the GitHub Copilot Agent Tasks API,
use a Copilot subscription token, or alter the credentials of CodeRabbit,
OpenCode Review, Noema, Strix, or the central merge scheduler.

## Threat model

The coding model, repository text, issue metadata, generated source, generated
tests, pull-request metadata, and produced patch are all untrusted. The protected
assets are:

- repository and pull-request mutation authority;
- OIDC request credentials;
- the NVIDIA provider key;
- reviewer and scanner identities;
- protected workflow and governance files;
- the protected `develop` head; and
- the integrity of independently verified source changes.

The primary abuse cases are indirect prompt injection, secret exfiltration,
workflow self-modification, scanner suppression, generated tests that mutate the
runner before publication, stale-base publication, duplicate PR races, opaque or
oversized artifact insertion, and metadata injection.

## Three trust zones

### Untrusted coding-agent job

The agent job has read-only repository, issue, and pull-request permissions.
OpenCode receives the NVIDIA provider key only in its own step. GitHub mutation
variables and OIDC request variables are removed from that process.

OpenCode is configured with a provider allowlist and denied general shell,
network, external-directory, subagent, skill, question, and LSP access. Its only
shell operations are exact `scopeweave-agent-check` commands. That root-owned
wrapper starts npm checks through `env -i`, preventing test subprocesses from
inheriting the NVIDIA key.

The model may edit ordinary product files, but not `.github`, `.git`, AGENTS.md,
SECURITY.md, CODEOWNERS, `.gitmodules`, `.npmrc`, OpenCode configuration,
scanner-suppression files, package manifests, `scripts/ci/**`, or the workflow's
contract and trust documentation. These paths define the verifier's commands or
security boundary and therefore remain fixed to the protected starting commit.
Issue and merged-PR bodies are not inserted into the model context.

Before packaging, the workflow stages the complete working tree and rejects:

- more than 40 changed files;
- patches larger than 2 MiB;
- files larger than 10 MiB;
- `.github` or governance changes;
- scanner suppressions;
- symbolic links and non-regular files;
- Git binary changes or files containing NUL bytes;
- recognizable GitHub or NVIDIA credential literals; and
- a non-regular or larger-than-50-KiB `PR_MESSAGE.md`.

The job emits a full-index binary patch, exact starting SHA, bounded PR title and
body, per-file SHA-256 manifest, patch digest, and manifest digest. It cannot
commit, push, open a pull request, approve, merge, publish, or release.

### Secret-free verification job

A fresh verifier runner has read-only repository permission and no NVIDIA secret.
It checks out the trusted `develop` ref, requires that checkout's SHA to equal the
agent's exact starting SHA, checks both expected digests, validates every bundle
member, and applies the binary patch to the index. It does not use a dynamic
checkout ref derived from untrusted job output and does not enable a shared npm
cache. The deterministic command definitions in `package.json`,
`package-lock.json`, `scripts/ci/**`, and this workflow contract are protected
from the patch, so generated code cannot redefine its own verifier. The job then
repeats:

- lockfile installation with lifecycle scripts disabled;
- the full unit suite;
- the full API suite;
- production coverage;
- docstring evidence;
- installation of Chromium and its system dependencies through the pinned
  Playwright package, followed by cloud browser end-to-end tests;
- staged-diff validation; and
- byte-for-byte patch reconstruction.

The verifier proves that running generated tests did not alter the patch. It
uploads only the unchanged verified bundle.

### Trusted publication job

A third fresh runner is the only job with `contents: write` and
`pull-requests: write`. It never installs packages, runs tests, executes generated
source, or receives the NVIDIA key.

The publisher checks out the trusted `develop` ref, requires its checkout SHA
to equal the verified starting SHA, and rechecks the bundle digests, centralized
protected-path set, exact live `develop` SHA, and empty PR queue. It sanitizes
the conventional title and body, creates one commit on a run-specific branch,
and checks the queue before push, after push, and after PR creation. A competing
PR causes the new branch or PR to be removed. The workflow never approves or
merges its own change.

## Provider and supply-chain contract

The workflow pins OpenCode `1.18.18` and the published SHA-256 digest of the
Linux x64 release archive. It does not install `latest` or execute a remote
installer. The OpenCode configuration follows the documented custom
OpenAI-compatible provider structure:

- explicit provider identifier;
- `@ai-sdk/openai-compatible`;
- NVIDIA `baseURL`;
- environment-derived API key;
- provider allowlist;
- explicit model map;
- token limits; and
- granular tool permissions.

The ordered fallback pool is:

1. `nvidia/llama-3.3-nemotron-super-49b-v1.5`;
2. `nvidia/nemotron-3-super-120b-a12b`; and
3. `deepseek-ai/deepseek-v4-pro`.

The model pool has a bounded three-hour aggregate execution budget inside a
200-minute agent job and a one-hour per-candidate ceiling. Each candidate receives
a fair share of the remaining budget, leaving a safety window for packaging. A
failed candidate causes a hard reset and untracked-file cleanup before the next
candidate. Failure of all candidates produces no artifact or pull request.
Artifact upload and download actions are pinned to immutable commit SHAs.

## Product-quality contract

Every autonomous run is limited to one buyer-visible vertical slice and requires:

- red-green-refactor through allowlisted deterministic checks;
- realistic tenant, concurrency, failure, migration, recovery, scale, and
  accessibility tests appropriate to the slice;
- 100% production statement, branch, function, and line coverage for new or
  materially changed production modules;
- complete beginner-readable public API documentation;
- descriptive two-word-or-longer `snake_case` durable database objects and third
  normal form;
- standalone operation and replaceable MSA adapters;
- contextual-orchestrator for product LLM paths;
- deterministic validation of model output before persistence;
- authoritative standards or peer-reviewed evidence already reviewed into the
  repository;
- APA 7th source traceability under `docs/doctoring`; and
- Figma or Product Design only for genuine buyer-facing interaction work.

Network research is deliberately unavailable to the secret-bearing model
process. When the required current authority is absent from reviewed repository
evidence, the agent must choose another gap.

## Verification evidence

`tests/config/hourly-opencode-commercial-readiness.test.mjs` locks the following
properties:

- hourly non-cancelling single-flight scheduling;
- three separate trust-zone jobs;
- NIM-only provider configuration;
- no Copilot token consumption or Agent Tasks endpoint;
- checksum-verified OpenCode installation;
- valid bounded OpenCode permission keys;
- direct invocation of the secret-free shell helper rather than the invalid
  `exec`-of-a-shell-function pattern;
- open-PR fail-closed behavior and bounded aggregate model fallback;
- one centralized protected-path definition shared by agent and publisher,
  including package manifests, CI helpers, scanner suppressions, and the
  workflow's own contract documentation;
- metadata, file-count, patch-size, binary, symlink, and credential boundaries;
- per-file bundle hashing and patch hashing;
- immutable action pins;
- trusted fixed-ref checkout without shared npm caching, protected verification
  command definitions, Playwright browser installation, and complete secret-free
  deterministic verification;
- stale-base and duplicate-queue refusal before and after PR creation; and
- no self-approval or self-merge.

The exact branch contract test and YAML/shell syntax must pass on the PR head.
The first live empty-queue run remains necessary to validate the configured
secret, hosted models, release asset, artifact exchange, and race handling in a
GitHub-hosted runner.

## Limitations

GitHub scheduled workflows are best-effort and may be delayed. GitHub does not
provide an atomic repository-wide compare-and-create transaction for arbitrary
PR producers. The workflow narrows the race with repeated checks and
post-creation cleanup but does not claim mathematical exclusion against every
external client.

Provider catalog changes, model retirement, quota, Actions capacity, secret
rotation, or network failure can prevent a run. Every such condition fails
closed and creates no product PR.

## References

Anomaly. (2026a). *Config*. OpenCode.
https://opencode.ai/docs/config

Anomaly. (2026b). *Permissions*. OpenCode.
https://opencode.ai/docs/permissions

Anomaly. (2026c). *Providers*. OpenCode.
https://opencode.ai/docs/providers

GitHub. (2026a). *Events that trigger workflows*. GitHub Docs.
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

GitHub. (2026b). *Security hardening for GitHub Actions*. GitHub Docs.
https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions

GitHub. (2026c). *Workflow syntax for GitHub Actions*. GitHub Docs.
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax

National Institute of Standards and Technology. (2022). *Secure software
development framework (SSDF) version 1.1: Recommendations for mitigating the
risk of software vulnerabilities* (NIST SP 800-218).
https://doi.org/10.6028/NIST.SP.800-218

NVIDIA Corporation. (2026). *NVIDIA NIM for large language models API
reference*. NVIDIA Documentation.
https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html
