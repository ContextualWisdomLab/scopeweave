# Work-item hierarchy domain evidence

Status: **active PR evidence; not protected-`develop` shipped behavior**.

Issue #287 calls for a four-level Phase → Activity → Task → Duty planning model without destroying existing three-level plans. Protected `develop` currently stores explicit `id`, `parentId`, and `depth` fields and its editor validates only depths 1–3. This slice deliberately does not change the browser editor, database schema, APIs, exports, or persisted records. It establishes the framework-independent domain boundary that those adapters can reuse in a later vertical integration.

## Decision and customer invariant

`server/work_item_hierarchy.mjs` defines a fixed four-level vocabulary and two operations: validate persisted relationships and project valid records into a canonical read model. The projection preserves every customer-supplied record, ID, parent relationship, source order, and persisted field. Existing three-level plans remain three-level; a Duty is never synthesized merely to make the structure four levels deep.

The validator fails closed on malformed record containers, blank/non-string/unsafe IDs, duplicate IDs, depth outside 1–4, missing parents, parents that are not exactly one level above the child, and parent-reference cycles. Validation is independent of input order so imported or database-returned records do not need to be physically grouped before structural integrity can be established. The implementation uses maps and bounded parent traversal rather than nested full-list scans; a realistic 10,000-record fixture is part of the behavior suite.

This is a domain contract, not a claim that ScopeWeave's current UI already edits Duty records. A later integration must update editor labels/validation, import/export, persistence/API contracts, analytics traversal, browser acceptance evidence, and migration/rollback documentation together before issue #287 can claim four-level support as shipped truth.

## TDD evidence

The first branch commit, `29ef935f9356c59b88eda2d1c648acb78848781b`, added `tests/unit/work-item-hierarchy.test.mjs` importing an absent `server/work_item_hierarchy.mjs`. The target module did not exist on the branch or protected base, so the executable contract was RED with `ERR_MODULE_NOT_FOUND` before implementation.

Commit `bcc5f70200dc3d2a45fcb6acf0dd427485a93c32` added the production module. The focused behavior suite then passed locally under Node after recreating the exact module/test contents in an isolated runtime. The repository coverage producer is extended to instrument the module and execute the hierarchy suite under `c8`; hosted exact-head Istanbul statement/branch/function/line results remain mandatory before merge and are not inferred from the focused run.

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
