# contextual-orchestrator Production Contract

ScopeWeave delegates AI briefing work to `contextual-orchestrator`; it does not
silently replace unavailable production inference with deterministic text.

## Required environment

```text
ORCHESTRATOR_URL=https://orchestrator.example
ORCHESTRATOR_TOKEN=<secret>
ORCHESTRATOR_MODEL=contextual-orchestrator
```

Production requests fail closed when the endpoint or bearer token is absent.
Non-loopback HTTP endpoints are rejected, requests are bounded to 120 seconds,
message count and content size are validated, provider payloads are not exposed
in errors, and an empty or malformed assistant response is never reported as a
successful briefing.

The deterministic adapter is available only when `SCOPEWEAVE_DEV=1` and the
endpoint is absent. That variable must never be set in staging or production.

## Orchestration responsibility

ScopeWeave intentionally sends only a versioned OpenAI-compatible request to
the orchestration service. Model selection, single-model versus multi-agent
allocation, task decomposition, role-specific reasoning effort, recursion
limits, access lists, synthesis, and verification belong to
`contextual-orchestrator`, where they can be evaluated and evolved centrally.
This separation is consistent with learned coordination research: Conductor
learns task decompositions, worker assignments, communication topologies, and
recursive test-time scaling; TRINITY adaptively assigns Thinker, Worker, and
Verifier roles over multiple turns; Fugu operationalizes learned orchestration
behind one model-compatible API.

ScopeWeave therefore does not hard-code a local fake solver, fixed topology, or
provider-specific bypass. Changes to orchestration policy require benchmarked
ablation evidence in `contextual-orchestrator`, including single-model,
parallel, sequential, hierarchical, recursive, and verifier-assisted paths.

## APA 7th references

Nielsen, S., Cetin, E., Schwendeman, P., Sun, Q., Xu, J., & Tang, Y. (2025).
*Learning to orchestrate agents in natural language with the Conductor*.
arXiv. https://doi.org/10.48550/arXiv.2512.04388

Sakana AI. (2026). *Sakana Fugu: Multi-agent system as a model*.
https://sakana.ai/fugu/

Xu, J., Sun, Q., Schwendeman, P., Nielsen, S., Cetin, E., & Tang, Y. (2025).
*TRINITY: An evolved LLM coordinator*. arXiv.
https://doi.org/10.48550/arXiv.2512.04695
