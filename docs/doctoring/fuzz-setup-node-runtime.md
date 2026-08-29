# Fuzz workflow Node.js action runtime

## Status

Implemented on active PR #523 only until the change reaches protected `develop`.

## Problem

The repository-owned `Fuzz` workflow pinned `actions/setup-node` v4.1.0 at commit `39370e3970a6d050c480ffad4ff0ed4d3fdee5af`. GitHub Actions is retiring the Node.js 20 action runtime, so retaining that predecessor action creates avoidable runner compatibility risk.

This is separate from the Node.js version used to execute ScopeWeave. The workflow continues to request Node.js `22.13.0` for the project-under-test; only the JavaScript runtime bundled by `actions/setup-node` changes.

## Decision

Pin the official `actions/setup-node` v7.0.0 release by immutable commit SHA `820762786026740c76f36085b0efc47a31fe5020` in `.github/workflows/fuzz.yml`.

The official v7.0.0 action metadata declares the Node.js 24 action runtime. The immutable pin preserves supply-chain provenance and avoids relying on a mutable major-version tag.

## Test-first evidence

On PR #523, test-only commit `465a26b289b8b3a9f50ea09c45c5eee0a266e8bc` extended `tests/unit/fuzz-exact-head-contract.test.mjs` to require the immutable v7.0.0 setup-node pin and reject the deprecated v4.1.0 pin while the production workflow still used v4.1.0. That commit therefore established the RED contract before production changed.

Production commit `4c284d6bcb76a70cceb74b6366fb636b5a41c781` changed only the fuzz setup-node action pin from v4.1.0 to v7.0.0. It retained Node.js `22.13.0`, npm caching, least-privilege contents access, exact-contributor-head checkout and runtime attestation, bounded iteration budgets, and the same fuzz command.

This evidence subsumes the equivalent setup-node and exact-head fuzz work from overlapping PR #547 while keeping #523 as the older canonical CI-integrity owner.

## Verification contract

The repaired exact PR head must prove all of the following before integration:

- `unit-and-api` passes the executable fuzz workflow contract;
- `property fuzz` executes the exact pull-request contributor head with the immutable setup-node v7.0.0 pin;
- the workflow still installs Node.js `22.13.0` for ScopeWeave;
- repository and organization-required security/review gates are evaluated on the same exact head; and
- runner/provider warnings that do not come from repository source remain classified as infrastructure evidence rather than source defects.

## Rollback

Reverting to the v4.1.0 pin would deliberately restore the deprecated action runtime and must not be used merely to silence an unrelated CI failure. If v7.0.0 exposes a verified compatibility defect, select a supported immutable setup-node revision that declares a current runner-supported JavaScript runtime and update this contract and evidence together.

## References

GitHub. (2025, September 19). *Deprecation of Node 20 on GitHub Actions runners*. GitHub Changelog. https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/

GitHub. (2026, July 14). *v7.0.0* [Software release]. GitHub, `actions/setup-node`. https://github.com/actions/setup-node/releases/tag/v7.0.0

GitHub. (2026). *actions/setup-node action metadata, v7.0.0 (`820762786026740c76f36085b0efc47a31fe5020`)* [Source code]. GitHub. https://github.com/actions/setup-node/blob/820762786026740c76f36085b0efc47a31fe5020/action.yml
