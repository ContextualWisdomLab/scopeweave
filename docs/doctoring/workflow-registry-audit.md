# GitHub Actions workflow registry audit and cleanup

## Decision

ScopeWeave treats the GitHub Actions registry and the protected branch tree as separate control-plane authorities. Deleting workflow YAML does not prove that GitHub disabled the workflow identity. Conversely, an active registry identity absent from the protected tree is **not by itself sufficient disable authority**: GitHub can register a workflow while its YAML exists only on a non-default branch or another still-owned review lane.

The control therefore has two deliberately separate stages:

1. `scripts/ci/workflow_registry_audit.mjs` is a read-only detector that reconciles the complete Actions registry against one immutable protected-branch tree.
2. `scripts/ci/workflow_registry_cleanup.mjs` is an explicit operator control. It is dry-run by default, reports every `active_orphan` as a candidate, and can disable only the exact numeric candidate IDs separately named by the operator with `--workflow-id` after ownership review.

The cleanup command is not an autonomous scanner mutation path. Applying changes requires `--apply`, an exact 40-character `--expected-sha`, at least one explicitly reviewed `--workflow-id`, and an authenticated `GITHUB_TOKEN` with GitHub Actions write authority. Display names, filename keywords, and `active_orphan` classification alone never authorize a mutation.

Both stages use GitHub REST API version `2026-03-10`. The detector issues only `GET`; the cleanup path uses GitHub's dedicated workflow-disable endpoint only after fail-closed audit, explicit target selection, and live identity checks. Neither path changes repository YAML, product source, branch protection, secrets, tenant data, or ScopeWeave runtime state.

## Evidence model

Each audit result retains repository, branch, exact protected SHA, observation time, registry `total_count`, per-page URL/status/item-count receipts, exact protected workflow paths, and exact workflow ID/path/state/classification. Reused paths are never collapsed, but a repeated numeric workflow ID fails closed because it would make the registry observation ambiguous.

GitHub's documented `WorkflowState` values are recognized exactly: `active`, `deleted`, `disabled_fork`, `disabled_inactivity`, and `disabled_manually`. An unfamiliar future state is retained as `unresolved` regardless of whether its path exists in the protected tree. `unresolved` is evidence that the API contract changed or the observation needs operator investigation; it is never an inactive verdict and blocks cleanup application.

Classifications are deliberately narrow:

- `present_active`: repository-path identity exists in the protected tree and GitHub reports `active`;
- `present_inactive`: protected YAML exists but GitHub reports one of the documented inactive states;
- `active_orphan`: documented `active` repository-path identity is absent from the protected tree and must be ownership-reviewed before it can be selected for disable;
- `inactive_absent`: absent repository-path identity is already in a documented inactive state;
- `preserved_absent`: documented active absent identity explicitly exempted by the operator, for example while an active reviewed PR, non-default writer branch, or central governance contract owns its source;
- `github_dynamic`: GitHub-owned `dynamic/*` identity with a documented state, outside repository YAML lifecycle authority;
- `unresolved`: unknown workflow state; preserve exact ID/path/state, investigate the API/ownership change, and do not disable from this record.

Names such as `one-shot`, `repair`, or `bootstrap` never cause an orphan verdict. A legitimate one-shot-like workflow present in the protected tree is `present_active`; a branch-only workflow absent from the protected tree still needs explicit ownership review before any disable target is selected.

## Protected-tree absence proof

The normal path inventory uses the Contents API at the exact protected commit. A Contents `404` is ambiguous because GitHub can also conceal inaccessible resources as not found, so it is **not** treated as an empty workflow directory by itself.

If that exact Contents request returns 404, the detector resolves the same commit through the Git Commits API to its root tree SHA, reads the root tree, then reads the exact `.github` tree when present. It returns an empty protected-workflow list only after those immutable Git Data reads succeed and prove that `.github` or its `workflows` tree entry is genuinely absent. If the `workflows` tree exists, its non-recursive blob entries are converted back to canonical immediate `.github/workflows/*.yml|*.yaml` paths. A failed or ambiguous Git Data read, duplicate tree path, non-tree directory entry, truncated tree response, or non-canonical workflow blob fails closed.

## Read-only audit operation

Every known absent-but-supported repository workflow should be supplied as an explicit exception for that observation. A conservative audit can therefore preserve a reviewed not-yet-protected workflow or another explicitly owned exception without teaching the detector a name heuristic:

```bash
node scripts/ci/workflow_registry_audit.mjs \
  --repo ContextualWisdomLab/scopeweave \
  --branch develop \
  --preserve-path .github/workflows/hourly-opencode-commercial-readiness.yml \
  --preserve-path .github/workflows/opencode-review.yml \
  --preserve-path .github/workflows/scorecard.yml
```

Preserve paths must be canonical immediate `.github/workflows/*.yml` or `*.yaml` file paths. Parent traversal, nested paths, alternate separators, and directory-only values are rejected so an exception cannot ambiguously cover another control-plane location.

`GITHUB_TOKEN` is optional for public audit reads and is sent only in the Authorization header. Tokens and failed response bodies are never printed. Authorization failure, ambiguous missing resources, malformed JSON, incomplete pagination, duplicated workflow IDs, an off-origin pagination link, or protected-branch movement all fail closed without a partial success payload. A future workflow state is retained only as `unresolved`, never coerced into a disable-capable classification. Transient 500, 502, 503, and 504 responses use bounded 100 ms then 200 ms timer-backed retries before failing closed.

## Authorized cleanup operation

Use the cleanup command first without `--apply`. A dry run performs the same fresh audit and emits all exact `active_orphan` candidates, but its mutation `targets` list remains empty unless the operator also names reviewed candidate IDs:

```bash
node scripts/ci/workflow_registry_cleanup.mjs \
  --repo ContextualWisdomLab/scopeweave \
  --branch develop \
  --expected-sha <EXACT_PROTECTED_DEVELOP_SHA> \
  --preserve-path .github/workflows/hourly-opencode-commercial-readiness.yml
```

After reviewing current PRs, non-default branches/active writers, dependency ownership, and the candidate's exact ID/path/state, the operator can preview a specific reviewed subset by adding one or more `--workflow-id` arguments while still omitting `--apply`.

An apply operation is intentionally harder to invoke and never means “disable every orphan”:

```bash
GITHUB_TOKEN=<ACTIONS_WRITE_TOKEN> \
node scripts/ci/workflow_registry_cleanup.mjs \
  --repo ContextualWisdomLab/scopeweave \
  --branch develop \
  --expected-sha <EXACT_PROTECTED_DEVELOP_SHA> \
  --preserve-path .github/workflows/hourly-opencode-commercial-readiness.yml \
  --workflow-id <EXPLICITLY_REVIEWED_ACTIVE_ORPHAN_ID> \
  --apply
```

The operator contract is fail-closed:

- apply mode rejects missing authentication before audit or mutation network traffic;
- the supplied expected SHA must equal the audit's protected SHA;
- apply mode requires one or more positive safe-integer `--workflow-id` values and rejects duplicates;
- any `unresolved` identity blocks mutation;
- the dry-run candidate list contains only exact numeric IDs classified `active_orphan` with canonical repository workflow paths;
- every reviewed `--workflow-id` must still be present in that current candidate list or the operation fails; unselected candidates are never mutated;
- the whole reviewed target plan is preflighted before the first mutation so obvious path/ID/state drift cannot produce a partial cleanup;
- protected `develop` is re-read before mutation, before each target, and after the operation;
- every target's numeric ID, exact case-sensitive path, and state are re-read immediately before mutation;
- a concurrently completed `disabled_manually` transition is adopted rather than raced;
- only an explicitly selected, exact, still-`active` target receives `PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable`;
- the resulting state must be observed as `disabled_manually`; and
- a fresh post-operation audit on the same protected SHA must prove no selected workflow ID remains `active_orphan`.

Transient 500, 502, 503, and 504 responses on the disable request use bounded retry. Permission/authentication, identity, branch-movement, unexpected-state, malformed-evidence, and postcondition failures do not retry as if they were transport noise. GitHub response bodies are never surfaced in errors.

This control changes Actions registry state only. It does not restore or delete workflow YAML, create a temporary cleanup workflow, add a PAT to repository source, broaden `secrets: inherit`, change branch rules, or infer safety from display names. The operator must preserve or simply decline to select any absent identity whose source is still legitimately owned by a current PR, non-default writer branch, or external governance path.

## Verification contract

Audit regression coverage includes complete multi-page enumeration; truncation detection; duplicate workflow-ID rejection; real timer-backed bounded 5xx retry with an injectable test seam; fail-closed 403/404 handling; immutable Git-tree proof of a genuinely absent workflow directory; ambiguous 404 preservation; malformed JSON; branch movement; off-origin pagination; exact case-sensitive paths; path reuse without ID collapse; documented inactive workflow states; unknown present/absent/dynamic states retained as `unresolved`; GitHub dynamic workflows; explicit active-PR preservation; canonical preserve-path validation; and a legitimate present one-shot-like workflow.

Cleanup regression coverage separately proves dry-run candidate reporting with no implicit targets; immutable expected-SHA binding; unresolved-state refusal; explicit reviewed active-orphan selection; rejection of present/unknown/duplicate reviewed IDs; apply-time SHA and target requirements; authentication refusal before high-level audit traffic; whole-plan/pre-target revalidation; path identity drift and protected-branch movement blocking mutation; exact numeric-ID disable routing; `disabled_manually` verification; bounded transient 5xx retry; and fail-closed permission errors without response-body leakage.

Both modules are repository control-plane production code rather than shipped ScopeWeave application runtime. Both are included in the canonical `c8` owned-production coverage producer, and their focused test suites execute in normal unit and coverage cases so the operator surface cannot silently fall out of quality evidence.

## Recovery and rollback

Rolling back repository code removes the detector/operator commands, tests, coverage registrations, doctoring, and changelog entries together. It **does not re-enable workflow identities already disabled in GitHub**, because Actions registry state is an independent control-plane fact. Re-enabling an intentionally disabled workflow therefore requires a separate, freshly reviewed operator decision against the current protected tree and GitHub registry; source rollback must never silently manufacture that decision.

If an apply operation stops after disabling only part of a reviewed target plan, retain the before/after evidence, rerun the complete audit on the current protected SHA, review current owners again, and classify the remaining exact identities again. Do not blindly replay the stale target list. Already `disabled_manually` entries are safe to adopt; any changed path, state, ownership exception, unresolved classification, or protected-branch movement requires a new decision and a newly explicit `--workflow-id` selection.

## References

GitHub. (2026a). *REST API endpoints for workflows*. GitHub Docs. Retrieved August 17, 2026, from https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10

GitHub. (2026b). *Using pagination in the REST API*. GitHub Docs. Retrieved August 17, 2026, from https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2026-03-10

GitHub. (2026c). *Actions: WorkflowState*. GitHub Docs. Retrieved August 17, 2026, from https://docs.github.com/en/graphql/reference/actions#workflowstate

GitHub. (2026d). *Git database: Commits and trees*. GitHub Docs. Retrieved August 17, 2026, from https://docs.github.com/en/rest/git/commits?apiVersion=2026-03-10 and https://docs.github.com/en/rest/git/trees?apiVersion=2026-03-10

GitHub. (2026e). *Disabling and enabling a workflow*. GitHub Docs. Retrieved August 17, 2026, from https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows
