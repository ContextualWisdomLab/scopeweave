# Hourly OpenCode commercial-readiness operations

## Ownership

The repository workflow `.github/workflows/hourly-opencode-commercial-readiness.yml`
creates product-development pull requests. It does not review or merge them.
Organization-central workflows remain responsible for review dispatch, review
feedback repair, exact-head Checks, branch updates, independent approval, and
policy-compliant merge.

Only one scheduled product-development producer should exist for ScopeWeave.
Do not add a Copilot Agent Tasks scheduler or another repository-local PR merge
scheduler alongside this workflow.

## Required configuration

Configure the organization or repository Actions secret:

- `NVIDIA_NIM_API_KEY`: NVIDIA hosted NIM API credential.

The workflow maps this value to `NVIDIA_API_KEY` only for the OpenCode gate and
agent process. It does not use `COPILOT_GITHUB_TOKEN`, a Copilot subscription, a
fine-grained user token, or any review-agent credential.

No additional GitHub token is required. The trusted publication step uses the
job-scoped `GITHUB_TOKEN` with `contents: write` and `pull-requests: write`. The
OpenCode process explicitly removes GitHub mutation and OIDC variables from its
environment.

## Schedule and activation

The workflow runs at minute 41 of each UTC hour and also supports a manual dry
run. Scheduled workflows are active only after the workflow exists on the
default branch. Until its pull request merges into `develop`, no hourly agent is
scheduled.

A scheduled tick performs no coding when:

- an open pull request exists;
- pull-request inventory cannot be read;
- `NVIDIA_NIM_API_KEY` is absent;
- another hourly run is active;
- every configured NVIDIA model fails;
- the agent creates a commit instead of a working-tree change;
- protected review workflow or scanner-suppression files change;
- deterministic verification fails;
- another pull request appears before publication; or
- the agent produces no source change.

These outcomes are intentional fail-closed states, not reasons to bypass the
queue or required Checks.

## Manual dry run

From the Actions page, select **Hourly ScopeWeave OpenCode Commercial Readiness**,
choose **Run workflow**, and set `dry_run` to `true`. The run evaluates the
single-flight gate and prints the bounded assignment to the step summary without
checking out source, invoking NVIDIA NIM, creating a branch, or opening a pull
request.

A dry run still requires an empty pull-request queue and a configured NVIDIA
secret because it verifies the same activation preconditions as a live run.

## OpenCode and model updates

The workflow pins:

- the OpenCode release number;
- the SHA-256 digest of the Linux x64 archive; and
- an ordered NVIDIA NIM model-candidate pool.

To update OpenCode:

1. inspect the official release and security notes;
2. download the exact `opencode-linux-x64.tar.gz` asset independently;
3. calculate its SHA-256 digest;
4. update both `OPENCODE_VERSION` and `OPENCODE_SHA256` in one reviewed pull
   request;
5. update the workflow contract test if the installation contract changes;
6. run a manual dry run and then one live empty-queue run; and
7. retain the previous version and digest in the pull-request evidence for
   rollback.

Never replace the pin with `latest`, an unverified installation script, or a
pull-request-controlled download URL.

To update models, verify the model identifier against the current NVIDIA hosted
catalog and confirm OpenCode tool-call behavior. Keep at least two independent
candidates so a single model outage does not silently create partial work. A
failed candidate is followed by `git reset --hard` and `git clean -fd`; partial
changes never flow into the next candidate.

## Verification and publication

After OpenCode exits successfully, trusted workflow steps:

1. prove the agent did not create commits;
2. enumerate tracked and untracked changes;
3. reject protected reviewer workflows and scanner-suppression files;
4. reject credential-like literals;
5. run `git diff --check`;
6. run `npm ci`;
7. run the full unit and API suites;
8. run coverage and configured docstring evidence;
9. run cloud browser E2E when available;
10. recheck that the open pull-request queue is still empty;
11. remove temporary OpenCode configuration and context snapshots;
12. create one conventional commit on `nim-agent/product-dev-<run-id>`; and
13. open one pull request against `develop`.

The newly opened pull request is not approved by this workflow. Required GitHub
Checks, CodeRabbit, Noema, OpenCode-review, Strix, unresolved-thread rules, and
independent approval remain authoritative.

## Failure diagnosis

### `pull_request_inventory_unavailable`

Confirm that GitHub API access and repository Actions are healthy. Do not convert
this state into an empty queue. Rerun after the API is available.

### `open_pull_request`

No action is required. The central PR loop owns review, repair, revalidation, and
merge. The next empty-queue hourly tick may start product development.

### `nim_api_key_unavailable`

Verify that `NVIDIA_NIM_API_KEY` is available to this repository through the
organization or repository secret policy. Do not print or copy the secret into a
workflow variable, issue, log, or pull request.

### Archive checksum failure

Treat the release artifact as untrusted. Compare the configured version, asset
URL, and independently calculated digest. Update the pin only through a reviewed
pull request. Never disable `sha256sum -c`.

### All model candidates fail

Inspect provider availability and fixed OpenCode logs for the operation. Do not
reuse partial working-tree output. Confirm the NVIDIA endpoint, model catalog,
key validity, and rate or quota status before changing the pool.

### Protected-file boundary failure

Review the agent diff manually. Do not whitelist changes to CodeRabbit, Noema,
OpenCode-review, Strix, security-review, `.trivyignore`, `.semgrepignore`, or
`.gitleaksignore` in this workflow. Such changes require a separately scoped,
human-authored governance pull request.

### Deterministic test failure

The workflow must not publish. Reproduce the failure on a normal development
branch, fix the product or test contract, and rerun the full suite. Do not skip,
ignore, suppress, or lower coverage thresholds.

### Queue changed before publication

Another pull request appeared while OpenCode was working. The trusted publisher
leaves the agent output unpublished. The active pull request owns the queue and
must complete through central governance first.

## Rollback

Disable the loop without deleting evidence by disabling the workflow in GitHub
Actions. A source rollback reverts the workflow, its contract test, operations
record, doctoring record, and CHANGELOG entry together. Disabling or reverting
the product-development loop does not change the organization-central review
workflows or their credentials.

If a newly opened agent pull request is unsafe or duplicate, close that pull
request and delete only its `nim-agent/product-dev-*` branch. Do not weaken
branch protection to merge it.
