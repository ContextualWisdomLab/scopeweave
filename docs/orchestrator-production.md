# contextual-orchestrator Production Contract

ScopeWeave delegates AI briefing work to `contextual-orchestrator`; it does not
silently replace unavailable production inference with deterministic text.

## Required environment

```text
ORCHESTRATOR_URL=https://orchestrator.example
ORCHESTRATOR_TOKEN=<secret>
ORCHESTRATOR_MODEL=contextual-orchestrator
```

`ORCHESTRATOR_URL` is a provider **origin**, not an arbitrary request URL. It
must not contain user-info credentials, a non-root path, a query string, or a
fragment. ScopeWeave owns the fixed `/v1/chat/completions` request path and keeps
bearer credentials in `ORCHESTRATOR_TOKEN`; operator URL text therefore cannot
silently alter request routing or mix endpoint authority with credentials.
Custom ports remain valid because they are part of the origin.

Production requests fail closed when the endpoint or bearer token is absent.
Non-loopback HTTP endpoints are rejected, requests are bounded to 120 seconds,
message count and content size are validated, provider payloads are not exposed
in errors, and an empty or malformed assistant response is never reported as a
successful briefing.

Provider response bodies have a hard 1 MiB caller-side byte budget **while they
are being read**. An oversized numeric `Content-Length` is rejected before body
allocation; when the header is absent or inaccurate, the stream reader counts
bytes incrementally, cancels the body as soon as the budget is exceeded, and
never buffers an unbounded provider payload before applying the limit. Empty,
non-stream-readable, malformed-length, non-JSON, oversized, or structurally
invalid responses fail with stable operator-safe errors rather than exposing
provider payload details.

The deterministic adapter is available only when `SCOPEWEAVE_DEV=1` and the
endpoint is absent. That variable must never be set in staging or production.

## Orchestration responsibility

ScopeWeave explicitly sends `orchestration_mode: "auto"` together with the
configured model and validated messages on production briefing requests. The
current protected `ContextualWisdomLab/contextual-orchestrator` `main` contract
verified for this change, commit
`6841b71935e0b7cb98fb52bcb4709cc5100c8d87`, accepts `auto`, `route`, and
`conduct` as orchestration modes. ScopeWeave chooses `auto` as its default so
execution policy can be optimized centrally without coupling this product to a
specific provider, worker count, topology, verifier pattern, or cost heuristic.
Those internal choices remain `contextual-orchestrator` authority and are not a
ScopeWeave compatibility promise.

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
