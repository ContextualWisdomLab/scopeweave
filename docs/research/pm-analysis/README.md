# PM Analysis Research Basis

This folder preserves the source material used for the first requirements/RFI/RFP
and WBS-estimation analysis slice.

## Preserved papers and handbooks

| File | Why it is used |
| --- | --- |
| `papers/requirements-engineering-for-ai-systems-mapping-study.pdf` | Requirements engineering is treated as elicitation, analysis, specification, validation, and management; ScopeWeave uses WBS text and deliverables as auditable requirement signals. Source: <https://arxiv.org/pdf/2212.10693>. |
| `papers/development-effort-estimation-foss-vcs.pdf` | Effort estimation needs observable evidence and validation; ScopeWeave reports whether duration, story points, or budget evidence exists instead of inventing an estimate. Source: <https://link.springer.com/content/pdf/10.1007/s10664-022-10166-x.pdf>, CC BY 4.0. |
| `papers/nasa-work-breakdown-structure-handbook.pdf` | WBS is the decomposition surface for scope, cost, schedule, deliverables, and control accounts; ScopeWeave scores leaf work packages and missing deliverables. Source: <https://www.nasa.gov/wp-content/uploads/2023/08/nasa-work-breakdown-structure-handbook.pdf>. |
| `papers/wbs-risk-based-standard-cost-estimation-port-project.pdf` | WBS-based planning can be linked to risk and cost estimation; ScopeWeave flags missing dependency evidence and budget/estimate coverage. Source: <https://iopscience.iop.org/article/10.1088/1755-1315/258/1/012051/pdf>, Open Access. |

## Preserved standards

| File | Why it is used |
| --- | --- |
| `standards/rfc2119.txt` and `standards/rfc8174.txt` | BCP 14 requirement language supports consistent MUST/SHOULD/MAY handling for RFI/RFP and requirement packages. Sources: <https://www.rfc-editor.org/rfc/rfc2119.txt>, <https://www.rfc-editor.org/rfc/rfc8174.txt>. |
| `standards/json-schema-2020-12-core.html` and `standards/json-schema-2020-12-validation.html` | JSON Schema 2020-12 is the current JSON Schema release and is the reference point for future machine-readable requirement/RFP package validation. Sources: <https://json-schema.org/draft/2020-12/json-schema-core.html>, <https://json-schema.org/draft/2020-12/json-schema-validation.html>. |

## Implementation mapping

- `computePmAnalysis()` is deterministic and dependency-free. It scores existing
  WBS fields rather than calling an LLM or external estimator.
- Requirement evidence comes from WBS text, categories, and deliverable names.
- WBS estimation readiness requires at least one concrete estimation signal per
  leaf work package: duration, story points, or budget.
- Inter-event dependency readiness is based on `predecessors`, CPM cycle
  detection, and dangling predecessor references.
- RFI/RFP readiness is a checklist over requirements, WBS scope/deliverables,
  schedule, commercial/budget, evaluation criteria, and question/clarification
  loops.

## Copyright-limited standards

ISO/IEC/IEEE 29148:2018 is relevant to requirements engineering, but the full
standard text is copyright-restricted and is not vendored here. This slice uses
only publicly linkable metadata and keeps the repository-preserved standards to
redistributable BCP 14 and JSON Schema documents.
