# Contextual-orchestrator adaptive planning default

## Status

Active pull-request evidence. This record does not describe protected `develop` until the owning pull request is integrated.

## Decision boundary

ScopeWeave owns the meaning, authorization, cost attribution, and presentation of a planning-analysis request. The shared `contextual-orchestrator` service owns provider/model selection and the depth/topology of execution. Production ScopeWeave requests therefore send `orchestration_mode: "auto"` explicitly instead of relying on an implicit gateway default or selecting `route`/`conduct` locally.

The binding dependency evidence verified for this slice is protected `ContextualWisdomLab/contextual-orchestrator` `main` commit `6841b71935e0b7cb98fb52bcb4709cc5100c8d87`. At that revision, `/v1/chat/completions` accepts `orchestration_mode`, permits `auto`, `route`, and `conduct`, accepts bounded attribution metadata, and routes execution through the orchestrator rather than treating the request model label as a provider lock.

This decision does **not** promise a specific provider, model, worker count, topology, verifier strategy, or cost heuristic. Those remain shared-service policy and may evolve behind its versioned contract.

## Attribution and tenant authority

Authenticated project AI briefings attach `service=scopeweave` and the project organization as `account` only after membership-scoped project authorization. Browser request fields cannot select another tenant's accounting identity. The client forwards only supported attribution dimensions, accepts bounded strings or finite numeric identifiers, uses a prototype-free validated map, and omits empty attribution. These labels are accounting metadata and never grant execution-provider or model-selection authority.

## Security and standalone behavior

The change preserves the protected ScopeWeave orchestrator boundary: authenticated canonical provider origin, HTTPS outside explicit loopback development, bounded messages, 120-second request timeout, bounded streamed provider responses, sanitized failures, and deterministic text only under explicit `SCOPEWEAVE_DEV=1` development mode. No provider credential or caller-controlled execution policy is added.

## TDD and overlap-convergence evidence

The adaptive-mode work originally existed separately in PR #529 while cost attribution occupied the same production request-body boundary in PR #496. Keeping both as independent roots created a concrete future regression risk: whichever branch integrated second could erase the other request field. The older attribution owner was therefore made the canonical combined boundary rather than allowing two competing implementations.

On the canonical branch, test-only commits `dc71cdff9dc258b8f196c35d9b92c1542e869043` and `5510058ae7437ede44fb7a7fd94351ac7f7d6b14` first require `orchestration_mode: "auto"` both on ordinary hardened requests and while tenant-bound attribution is present or omitted. Source commit `bd8878591bfa74b67ae2a36b122513d2c41e376f` then composes adaptive routing with the existing sanitized attribution request. Exact-current-head hosted evidence remains authoritative; predecessor checks are not reused.

## Rollback

Rollback of adaptive mode removes the explicit `orchestration_mode` field and its matching regression/documentation while preserving the tenant-bound attribution and hardened transport. Rollback of attribution separately removes only the attribution call-site, sanitizer, and attribution regressions. Neither rollback may restore stale pre-hardening orchestrator source or a self-modifying workflow.

## APA 7th references

Contextual Wisdom Lab. (2026). *contextual-orchestrator* (Commit 6841b71935e0b7cb98fb52bcb4709cc5100c8d87) [Computer software]. GitHub.

Nielsen, S., Cetin, E., Schwendeman, P., Sun, Q., Xu, J., & Tang, Y. (2025). *Learning to orchestrate agents in natural language with the Conductor*. arXiv. https://doi.org/10.48550/arXiv.2512.04388

Sakana AI. (2026). *Sakana Fugu: Multi-agent system as a model*. https://sakana.ai/fugu/

Xu, J., Sun, Q., Schwendeman, P., Nielsen, S., Cetin, E., & Tang, Y. (2025). *TRINITY: An evolved LLM coordinator*. arXiv. https://doi.org/10.48550/arXiv.2512.04695
