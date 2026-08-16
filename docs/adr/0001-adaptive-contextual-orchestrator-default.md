# ADR-0001: Adaptive contextual-orchestrator mode is the briefing default

- Status: Accepted
- Date: 2026-08-16

## Context

ScopeWeave delegated AI briefing generation to contextual-orchestrator but omitted an explicit execution mode. The gateway currently interprets omission as adaptive `auto`, yet the consumer contract did not prevent a future default drift to one fixed worker or make the expected quality-cost policy reviewable.

## Decision

Every production briefing request includes `orchestration_mode: "auto"`.

Contextual-orchestrator owns model/provider selection, test-time compute, workflow depth, verification, fallback, and known-price optimization. Quality sufficiency is the first constraint; cost is minimized among paths that satisfy it. A model without trustworthy price metadata is unpriced, not free.

ScopeWeave continues to own message validation, origin and credential boundaries, response-size limits, stable error classification, and product-specific briefing prompts. Explicit fixed modes may be used only in a documented ablation or incident override and are not product defaults.

## Consequences

Simple briefings may still use one worker when adaptive policy finds that sufficient. More complex or risky analyses may use a deeper workflow without changing ScopeWeave's public API.

## References

Omidvar, H., & Akhlaghi, V. (2026). *A communication-theoretic framework for LLM agents: Cost-aware adaptive reliability* [Preprint]. arXiv. https://doi.org/10.48550/arXiv.2605.09121

Tang, Y., Cetin, E., Xu, J., Sun, Q., Nielsen, S., Richard, V., Goda, H., Tymchenko, I., Nguyen, N., Lee, H., Ashiga, M., Kotyan, S., Kuroki, S., & Clanuwat, T. (2026). *Sakana Fugu technical report* [Technical report]. arXiv. https://doi.org/10.48550/arXiv.2606.21228
