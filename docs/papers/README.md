# Reference papers

Background literature for the ScopeWeave **issue / Service-Request management**
layer (ITSM intake → approval → fulfillment → closure, and the requirements /
work-item model that feeds it).

Both papers are published **Open Access under the Creative Commons Attribution
4.0 International License (CC BY 4.0)** — a permissive, commercially usable
license that only requires attribution. They are redistributed here unmodified
under those terms. License text: <https://creativecommons.org/licenses/by/4.0/>.

## 1. IT Service Management (the Service-Request layer)

- **Title:** Digital Transformation of Public Sector Governance With IT Service
  Management — A Pilot Study
- **Authors:** M. I. Sarwar, Q. Abbas, T. Alyas, A. Alzahrani, T. Alghamdi, Y. Alsaawy
- **Venue:** IEEE Access, vol. 11, 2023, pp. 6490–6516
- **DOI:** [10.1109/ACCESS.2023.3237550](https://doi.org/10.1109/ACCESS.2023.3237550)
- **License:** CC BY 4.0
- **File:** `Sarwar-2023-IT-Service-Management-Public-Sector-IEEE-Access-CC-BY-4.0.pdf`
- **Why it's here:** Surveys ITSM standards/frameworks (ITIL, ISO/IEC 20000,
  FitSM, CobiT) and their service-management lifecycle — the conceptual basis for
  the Service Request state machine (catalog/intake → approval → fulfillment →
  closure with an SLA) implemented in `server/lifecycle.mjs` and
  `server/app.mjs`.

## 2. Requirements Engineering (the evidence-grounded work-item model)

- **Title:** A Systematic Study to Improve the Requirements Engineering Process in
  the Domain of Global Software Development
- **Authors:** M. A. Akbar, A. Alsanad, S. Mahmood, A. A. Alsanad, A. Gumaei
- **Venue:** IEEE Access, vol. 8, 2020, pp. 53374–53395
- **DOI:** [10.1109/ACCESS.2020.2979468](https://doi.org/10.1109/ACCESS.2020.2979468)
- **License:** CC BY 4.0
- **File:** `Akbar-2020-Requirements-Engineering-Process-Improvement-IEEE-Access-CC-BY-4.0.pdf`
- **Why it's here:** Frames the requirements-engineering process (extraction,
  analysis, specification, validation, management) that the ingestion endpoint
  (`POST /api/projects/:id/tasks:import`) maps into evidence-grounded work items
  — `kind ∈ {issue, requirement, feature, service_request}` carrying their
  `source_segment_uids` provenance and `confidence`.
