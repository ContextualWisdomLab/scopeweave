# Product technical gap baseline

Status: Proposed  
Last evaluated source commit: `9ae9244da2938971a349f6a7bd074b3a4981b958`  
Pull request: [#762](https://github.com/ContextualWisdomLab/scopeweave/pull/762)

## Product and boundary

ScopeWeave owns WBS planning truth and the planner presentation. This change only exposes descriptions for the three summary metrics. It does not alter task, schedule, progress, persistence, import/export, API, or database truth.

| Artifact | Current evidence | Status |
| --- | --- | --- |
| PRD | README and user guide define the planner; no dedicated PRD was found in the audited tree | Gap |
| TRD | ARCHITECTURE.md, docs/api.md, and docs/deploy.md | Existing |
| UML / ERD | No data-model change in #762; dedicated UML and ERD artifacts were not found in the audited tree | Gap, not in PR scope |
| Context Map | ScopeWeave remains the canonical WBS writer; no Core dependency added | Preserved |
| Gap | `title` alone did not expose help reliably, and `role="note"` misclassified primary metrics | Repaired, verification pending |
| Action | Keep #762 Draft until exact-head checks, current-head review, browser evidence, and required locale evidence are complete | Open |

## Exact-head acceptance matrix

| Dimension | Evidence | Status |
| --- | --- | --- |
| Determinism | Static markup and CSS only; metric calculation code unchanged | Not affected |
| Semantics | Three DOM descriptions linked with `aria-describedby`; `role="note"` removed | Local contract GREEN |
| Accessibility | Playwright contract covers description linkage and keyboard visibility | Exact-head CI queued |
| Responsive evidence | No desktop, intermediate, or mobile screenshots on the repaired head | FAIL |
| Locales | Current surface remains Korean; ko/en/ja/zh/vi/es/de/fr evidence is absent | FAIL |
| Large-data performance | No data path or rendering loop changed | Not affected |
| Import/export | No import/export code changed | Not affected |
| Recovery | No persistence or recovery code changed | Not affected |

An applicable FAIL is not merge-ready. The PR remains Draft until the missing evidence is attached to an unchanged successor head.
