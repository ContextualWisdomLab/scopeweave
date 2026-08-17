# Fuzz workflow Node.js action runtime

## Status

Implemented on active PR only until the change reaches protected `develop`.

## Problem

The repository-owned `Fuzz` workflow pinned `actions/setup-node` v4.1.0 at commit `39370e3970a6d050c480ffad4ff0ed4d3fdee5af`. Current GitHub-hosted runs warn that the action targets deprecated Node.js 20 and is being forced to run on Node.js 24. That compatibility override is runner behavior, not ScopeWeave-controlled evidence, and retaining the old action runtime creates avoidable future CI breakage risk.

This is separate from the Node.js version used to execute ScopeWeave. The workflow continues to request Node.js `22.13.0` for the project-under-test; only the JavaScript runtime bundled by `actions/setup-node` changes.

## Decision

Pin the official `actions/setup-node` v7.0.0 release by immutable commit SHA `820762786026740c76f36085b0efc47a31fe5020` in `.github/workflows/fuzz.yml`.

The official v7.0.0 `action.yml` declares `runs.using: node24`. The immutable pin preserves supply-chain provenance and avoids relying on mutable major-version tags.

## Test-first evidence

Test-only commit `7a73e9e22d42d391c8d7a823bdf47ad2221cebc2` added an executable workflow contract requiring the v7.0.0 immutable pin while production still used v4.1.0. Hosted Server Tests run `32019187595`, job `95355055643`, then failed at `tests/unit/coverage-script-contract.test.mjs:52` with the expected assertion that property fuzz must use the Node.js 24 setup-node runtime.

The production repair changes only the setup-node action pin. It does not alter workflow permissions, the project Node version, npm install behavior, fuzz iteration budgets, or the fuzz command.

## Verification contract

The repaired exact PR head must prove all of the following before integration:

- `unit-and-api` passes the workflow contract;
- `property fuzz` executes with the new immutable action pin and no Node.js 20 action-runtime deprecation warning attributable to `actions/setup-node`;
- the workflow still installs Node.js `22.13.0` for ScopeWeave;
- repository and organization-required security/review gates are evaluated on the same exact head; and
- any unrelated GitHub cache-service warning remains classified as infrastructure evidence rather than a source defect.

## Rollback

Reverting to the v4.1.0 pin would intentionally restore the deprecated action runtime and must not be used merely to silence an unrelated CI failure. If v7.0.0 exposes a verified compatibility defect, select a supported immutable setup-node revision that declares a current runner-supported JavaScript runtime and update this contract and evidence together.

## References

GitHub. (2025, September 19). *Deprecation of Node 20 on GitHub Actions runners*. GitHub Changelog. https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/

GitHub. (2026, July 14). *v7.0.0* [Software release]. GitHub, `actions/setup-node`. https://github.com/actions/setup-node/releases/tag/v7.0.0

GitHub. (2026). *actions/setup-node action metadata, v7.0.0 (`820762786026740c76f36085b0efc47a31fe5020`)* [Source code]. GitHub. https://github.com/actions/setup-node/blob/820762786026740c76f36085b0efc47a31fe5020/action.yml
