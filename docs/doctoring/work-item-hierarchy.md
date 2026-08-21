# Work-item hierarchy domain evidence

Status: **active PR evidence; not protected-`develop` shipped behavior**.

Issue #287 calls for a four-level Phase → Activity → Task → Duty planning model without destroying existing three-level plans. Protected `develop` currently stores explicit `id`, `parentId`, and `depth` fields and its editor validates only depths 1–3. This slice deliberately does not change the browser editor, database schema, APIs, exports, or persisted records. It establishes the framework-independent domain boundary that those adapters can reuse in a later vertical integration.

## Decision and customer invariant

`server/work_item_hierarchy.mjs` defines a fixed four-level vocabulary and two operations: validate persisted relationships and project valid records into a canonical read model. Each projection entry is an immutable wrapper containing an immutable `record` copy plus derived `kind` and `sourceIndex` metadata. Persisted values remain inside `record`, so customer fields named `kind` or `sourceIndex` cannot be silently overwritten by projection metadata. Parent absence is normalized to `null` in the projected record; every other customer-supplied field, ID, relationship, and source order is preserved. Existing three-level plans remain three-level; a Duty is never synthesized merely to make the structure four levels deep.

The validator fails closed on malformed record containers, blank/non-string/unsafe IDs, duplicate IDs, depth outside 1–4, missing parents, parents that are not exactly one level above the child, and parent-reference cycles. Validation is independent of input order so imported or database-returned records do not need to be physically grouped before structural integrity can be established. The implementation uses maps and bounded parent traversal rather than nested full-list scans; a realistic 10,000-record fixture is part of the behavior suite.

This is a domain contract, not a claim that ScopeWeave's current UI already edits Duty records. A later integration must update editor labels/validation, import/export, persistence/API contracts, analytics traversal, browser acceptance evidence, and migration/rollback documentation together before issue #287 can claim four-level support as shipped truth.

## TDD and review evidence

The first branch commit, `29ef935f9356c59b88eda2d1c648acb78848781b`, added `tests/unit/work-item-hierarchy.test.mjs` importing an absent `server/work_item_hierarchy.mjs`. The target module did not exist on the branch or protected base, so the executable contract was RED with `ERR_MODULE_NOT_FOUND` before implementation. Commit `bcc5f70200dc3d2a45fcb6acf0dd427485a93c32` then added the initial production module.

A current-source CodeRabbit review of predecessor head `ba26b89260ba8ac5142fc7c2ea76c0bb4f475036` identified a valid data-integrity defect in that initial projection shape: spreading a persisted record and then assigning derived `kind` and `sourceIndex` could silently replace customer fields with the same names. Regression commit `458cc39ba0a7a6f66bf35ea8d0533c6c4554fddb` changed the executable contract first to require persisted collision fields to survive under a separate `record` structure; that regression was incompatible with the predecessor production shape and therefore established the repair RED condition. Production commit `8f4981060d3c35776657d2fb90c12e7594daaa7b` moved derived metadata onto an immutable wrapper, preserving the normalized record separately. Commit `da31ed0cce6970d54544af6391d3bbbd968565a7` added direct `Object.isFrozen(...)` assertions for the level vocabulary, wrappers, and projected records, and commit `f9cdca28d1e2c276b61019a98453a82de1420c20` corrected the changelog wording from migration to projection.

The repository coverage producer instruments the module and executes the hierarchy suite under `c8`. Hosted exact-current-head Istanbul statement/branch/function/line results and all other applicable checks remain mandatory before merge; queued, pending, predecessor, skipped-required, neutral, or model-only evidence is not promoted to passing.

## Standards traceability

The current published international WBS standard is ISO 21511:2018. ISO marks it as published but under revision (stage 90.92). ISO/DIS 21511 Edition 2 is under development and therefore is research/forward-compatibility context, not a final normative dependency. The implementation follows the stable concept that a WBS is a hierarchical decomposition of project scope while intentionally keeping ScopeWeave's product-specific four-level labels separate from any claim that ISO mandates those exact four names or exactly four levels.

PMI's *Practice Standard for Work Breakdown Structures—Third Edition* likewise treats the WBS as organizing total project scope and explicitly covers predictive, agile, iterative, and incremental life cycles. That supports keeping the domain neutral to delivery method; the Phase/Activity/Task/Duty vocabulary is a ScopeWeave product decision, not an assertion that agile work must fit a waterfall ontology.

No empirical performance or psychometric claim is introduced by this slice, so a peer-reviewed experimental citation would not materially justify the structural validator. The executable 10,000-record regression is the relevant evidence for its algorithmic workload boundary; later UX latency claims must be backed by browser measurements on the integrated UI.

### APA 7 references

International Organization for Standardization. (2018). *Work breakdown structures for project and programme management* (ISO Standard No. 21511:2018). https://www.iso.org/standard/69702.html

International Organization for Standardization. (2026). *Project, programme and portfolio management—Work breakdown structures* (ISO/DIS 21511, Edition 2) [Draft International Standard]. https://www.iso.org/standard/87898.html

Project Management Institute. (2019). *Practice standard for work breakdown structures* (3rd ed.). Project Management Institute. https://www.pmi.org/standards/work-breakdown-structures-third-edition

## Integration and rollback

Integration order for this slice is intentionally narrow: first land the independently reviewed domain contract, then adapt one production boundary at a time while preserving legacy IDs and validating migrations against protected truth. Database object ownership remains with the schema-migration lane; this slice creates no table or migration and therefore cannot conflict with issue #433 / PR #500.

Rollback before adapter integration removes the domain module, focused tests, coverage registrations, this doctoring note, and the changelog entry together. Because no stored record is transformed and no schema is changed, rollback has no data-reversal step. Once future adapters consume the domain, rollback must preserve customer IDs and must not silently flatten or discard fourth-level work.
