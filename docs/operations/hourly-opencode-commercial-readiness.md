# Hourly OpenCode commercial-readiness operations

## Ownership

`.github/workflows/hourly-opencode-commercial-readiness.yml` may create one
bounded product-development pull request only when the repository has no open
pull request. Organization-central workflows remain responsible for review
dispatch, feedback repair, exact-head checks, independent approval, branch
updates, and policy-compliant merge.

Keep this workflow as the sole scheduled ScopeWeave product-development
producer. Do not add a repository-local merge scheduler or Copilot Agent Tasks
scheduler.

## Required configuration

Configure the organization or repository Actions secret:

- `NVIDIA_NIM_API_KEY`: NVIDIA hosted NIM API credential.

The workflow maps it to `NVIDIA_API_KEY` only for the OpenCode process. It does
not use a Copilot token, user-scoped GitHub token, reviewer credential, or OIDC
write credential.

## Schedule

The workflow runs at minute 41 of every UTC hour and supports manual dry-run
dispatch. Scheduled execution starts only after the workflow reaches the default
branch.

A tick produces no code when:

- the open-PR inventory cannot be read;
- any pull request is open;
- the NIM secret is unavailable;
- another hourly run is active;
- every model candidate fails;
- the model creates a commit;
- the change crosses a protected or bounded-content rule;
- secret-free verification fails;
- `develop` moves after verification; or
- another PR wins a publication race.

These are fail-closed outcomes. Never bypass the queue, checksum, review, or
branch-protection rules.

## Manual dry run

From GitHub Actions, select **Hourly ScopeWeave OpenCode Commercial Readiness**,
choose **Run workflow**, and set `dry_run` to `true`.

A dry run evaluates the empty-queue and secret preconditions and prints the
assignment. It does not check out source, run inference, create an artifact,
push a branch, or open a pull request.

## Trust-zone operations

### Agent

The agent runner has read-only GitHub permissions. General shell, web, external
directory, subagent, skill, question, and LSP tools are denied. Only exact
`scopeweave-agent-check` commands are available, and test processes receive a
clean environment without the NIM secret.

The agent cannot change workflow, governance, scanner-suppression, submodule,
npm/OpenCode configuration, package manifests, `scripts/ci/**`, the workflow
contract test, or its trust documentation. One workflow-level exact-path and
prefix definition is consumed by both the agent boundary and publisher. The
packaging boundary also rejects symlinks, opaque binary changes, large files,
credential-like literals, more than 40 files, a patch over 2 MiB, or
oversized/untrusted PR metadata.

### Verifier

The verifier receives no provider secret or write token. It checks out the
trusted `develop` ref and requires its actual SHA to equal the recorded starting
SHA before applying the patch. Dynamic output-derived checkout refs and shared
npm caching are not used. It validates all bundle digests, installs the lockfile
with lifecycle scripts disabled, and runs unit, API, coverage, docstring, and
browser end-to-end checks. `package.json`, `package-lock.json`, `scripts/ci/**`,
the workflow contract test, and the trust records are protected, so the patch
cannot redefine its own verification. Chromium and required system dependencies
are installed through the lockfile-pinned Playwright CLI immediately before E2E.

The verifier reconstructs and byte-compares the full-index patch after tests.
Any test-created source change blocks publication.

### Publisher

The publisher receives only the GitHub token required for branch and PR writes.
It never executes generated code. It checks out trusted `develop`, requires the
checkout and live branch to equal the verified starting SHA, validates the same
immutable bundle and centralized protected-path boundary, sanitizes metadata,
rechecks the PR queue around each mutation, and removes its own branch or PR if
another producer wins.

The publisher does not approve, auto-merge, merge, release, or publish a package.

## OpenCode maintenance

The workflow pins both the OpenCode version and Linux x64 archive digest.

To update OpenCode:

1. inspect the official immutable release and security notes;
2. obtain the exact Linux x64 asset digest from the release record and verify it
   independently;
3. update version and SHA-256 together;
4. update the workflow contract and doctoring record;
5. run the exact-head deterministic checks;
6. merge through normal independent review; and
7. retain the previous version and digest in rollback evidence.

Never substitute `latest`, a floating tag, or an installation script.

Verify every candidate model identifier against the NVIDIA catalog before
changing the pool. Preserve ordered fallback and cleanup between candidates. The
current pool shares a bounded three-hour execution budget within a 200-minute
agent job, caps each candidate at one hour, and reserves time for packaging.

## Artifact contract

The agent artifact contains:

- `changes.patch`: full-index binary patch;
- `start-sha.txt`: exact protected-base commit;
- `pr-title.txt`: bounded title candidate;
- `pr-body.md`: bounded body candidate; and
- `bundle.sha256`: SHA-256 for every member.

The patch digest and manifest digest also travel as immutable job outputs. Both
the verifier and publisher require the expected values and run
`sha256sum -c`.

Artifacts are retained for one day and transported only with immutable-SHA-pinned
official GitHub actions.

## Failure diagnosis

### `pull_request_inventory_unavailable`

Treat the queue as occupied. Confirm API and Actions health, then rerun. Never
reinterpret an unavailable inventory as empty.

### `open_pull_request`

Central governance owns the active PR. Continue maintenance on that PR instead
of creating a second product slice.

### `nim_api_key_unavailable`

Verify organization/repository secret policy. Do not copy the key into workflow
variables, issues, fixtures, artifacts, or pull requests.

### OpenCode checksum failure

Treat the archive as untrusted. Recheck the immutable release asset and digest.
Never disable `sha256sum -c`.

### Model candidate failure

Partial work is hard-reset before the next candidate. Candidate timeouts are
calculated from the remaining aggregate budget; the loop stops while a packaging
safety window remains. If every candidate fails, check provider availability,
model catalog, credential validity, quota, and rate limits through trusted
operator channels.

### Protected or bounded-content failure

Review the proposed diff outside this workflow. Do not expand autonomous access
to `.github`, governance, security policy, CODEOWNERS, submodules, package or
npm configuration, CI helpers, the workflow contract/trust records, scanner
suppressions, symlinks, binaries, large files, or secrets. Such changes require a
separately scoped human-authored PR.

### Verification failure

No verified artifact reaches publication. Reproduce the exact-head failure and
fix the implementation or test contract. Do not skip, suppress, or lower the
gate.

### Base or queue changed

The publisher intentionally refuses stale or duplicate work. The next
empty-queue run starts from the new protected base. Branches or PRs created
during a losing race are removed automatically.

## Rollback

Disable the workflow in GitHub Actions to stop scheduling immediately without
deleting history.

A source rollback reverts the workflow, contract test, operations record,
doctoring record, package script entry, and CHANGELOG entries together. It does
not alter organization-central reviewer identities or policies.

Close unsafe or duplicate autonomous PRs and delete their
`nim-agent/product-dev-*` branches. Do not weaken branch protection to merge
them.

## Activation evidence

After merge and after the open PR queue reaches zero:

1. run a manual dry run;
2. confirm the reason and assignment are correct;
3. run one live empty-queue execution;
4. record OpenCode version and archive verification;
5. record which NIM candidate completed;
6. confirm raw and verified artifact digests;
7. confirm the PR contains exactly one bounded slice;
8. confirm central review/check/merge ownership; and
9. add the run and resulting PR to release evidence.
