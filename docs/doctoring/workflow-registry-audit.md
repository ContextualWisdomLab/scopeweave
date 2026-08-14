# GitHub Actions workflow registry audit

## Decision

ScopeWeave treats the GitHub Actions registry and the protected branch tree as separate control-plane authorities. Deleting workflow YAML does not prove that GitHub disabled the workflow identity. `scripts/ci/workflow_registry_audit.mjs` therefore performs a read-only reconciliation before any separately authorized workflow-disable operation.

The detector has **no mutation mode**. It issues only `GET` requests, records exact workflow ID/path/state, verifies pagination completeness, reads `.github/workflows` at an exact protected commit SHA, and then re-reads the protected branch. Protected-branch movement invalidates the observation.

## Evidence model

Each result retains repository, branch, exact protected SHA, observation time, registry `total_count`, per-page URL/status/item-count receipts, exact protected workflow paths, and exact workflow ID/path/state/classification. Reused paths are never collapsed.

Classifications are deliberately narrow:

- `present_active`: repository-path identity exists in the protected tree;
- `present_inactive`: protected YAML exists but the registry identity is inactive;
- `active_orphan`: active repository-path identity is absent from the protected tree;
- `inactive_absent`: absent repository-path identity is already inactive;
- `preserved_absent`: absent identity explicitly exempted by the operator, for example while an active reviewed PR or central governance contract owns its source;
- `github_dynamic`: GitHub-owned `dynamic/*` identity, outside repository YAML lifecycle authority.

Names such as `one-shot`, `repair`, or `bootstrap` never cause an orphan verdict. A legitimate one-shot-like workflow present in the protected tree is `present_active`.

## Operator use

Every known absent-but-supported repository workflow must be supplied as an explicit exception for that observation. The current conservative ScopeWeave audit preserves the active hourly workflow owned by PR #444, the organization-authoritative OpenCode review identity, and Scorecard while its current ownership remains unresolved:

```bash
node scripts/ci/workflow_registry_audit.mjs \
  --repo ContextualWisdomLab/scopeweave \
  --branch develop \
  --preserve-path .github/workflows/hourly-opencode-commercial-readiness.yml \
  --preserve-path .github/workflows/opencode-review.yml \
  --preserve-path .github/workflows/scorecard.yml
```

Preserve paths must be canonical immediate `.github/workflows/*.yml` or `*.yaml` file paths. Parent traversal, nested paths, alternate separators, and directory-only values are rejected so an exception cannot ambiguously cover another control-plane location.

`GITHUB_TOKEN` is optional for public reads and is sent only in the Authorization header. Tokens and failed response bodies are never printed. Authorization failure, missing resources, malformed JSON, incomplete pagination, an off-origin pagination link, or protected-branch movement all fail closed without a partial success payload. Transient 500, 502, 503, and 504 responses use bounded 100 ms then 200 ms timer-backed retries before failing closed.

The output is evidence, not disable authority. Immediately before a separately authorized disable operation, re-read the protected branch and exact workflow identity/state and use GitHub's dedicated workflow-disable endpoint. Never disable by display name alone, and never promote `active_orphan` to an authorized disable without independently revalidating live exceptions and ownership.

## Verification contract

Regression coverage includes complete multi-page enumeration; truncation detection; real timer-backed bounded 5xx retry with an injectable test seam; fail-closed 403/404 handling; malformed JSON; branch movement; off-origin pagination; exact case-sensitive paths; path reuse without ID collapse; GitHub dynamic workflows; explicit active-PR preservation; canonical preserve-path validation; a legitimate present one-shot-like workflow; and CLI rejection of write-like arguments.

The detector is repository control-plane tooling, not shipped ScopeWeave application runtime. Its behavior is exercised through the normal unit-suite contract rather than being added to the application-runtime c8 ownership set.

## Rollback

Remove the detector, unit regression, package registration, doctoring record, and CHANGELOG entry together. The detector itself changes no workflow state, product persistence, authentication, tenant data, or runtime application behavior.

## References

GitHub. (2026a). *REST API endpoints for workflows*. GitHub Docs. Retrieved August 15, 2026, from https://docs.github.com/en/rest/actions/workflows

GitHub. (2026b). *Using pagination in the REST API*. GitHub Docs. Retrieved August 15, 2026, from https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api

GitHub. (2026c). *Disabling and enabling a workflow*. GitHub Docs. Retrieved August 15, 2026, from https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows
