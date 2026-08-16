# Contextual-orchestrator adaptive planning default

## Status

Active pull-request evidence. This record does not describe protected `develop` until the pull request is integrated.

## Decision boundary

ScopeWeave owns the meaning, authorization, and presentation of a planning-analysis request. The shared `contextual-orchestrator` service owns provider/model selection and the depth/topology of execution. Production ScopeWeave requests therefore send `orchestration_mode: "auto"` explicitly instead of relying on an implicit gateway default or selecting `route`/`conduct` locally.

The binding dependency evidence verified for this slice is protected `ContextualWisdomLab/contextual-orchestrator` `main` commit `6841b71935e0b7cb98fb52bcb4709cc5100c8d87`. At that revision, the `/v1/chat/completions` contract accepts `orchestration_mode` and permits `auto`, `route`, and `conduct`.

This decision does **not** promise a specific provider, model, worker count, topology, verifier strategy, or cost heuristic. Those remain shared-service policy and may evolve behind its versioned contract.

## Security and standalone behavior

The change preserves the protected ScopeWeave orchestrator boundary: authenticated canonical provider origin, HTTPS outside explicit loopback development, bounded messages, 120-second request timeout, bounded streamed provider responses, sanitized failures, and deterministic text only under explicit `SCOPEWEAVE_DEV=1` development mode. No provider credential or caller-controlled execution policy is added.

## TDD and branch-safety evidence

The feature branch originally contained a self-modifying write-capable workflow on a tree that had fallen behind protected `develop`. Continuing from it would have replaced later protected orchestrator hardening. That control path was removed and the branch was reconciled non-destructively with protected `develop@28420da358f57be5e85be3660251e39b85e1cc94` before product work resumed.

On the reconciled tree, test commit `177e2a12e1f6be32c5a9b91379f92cf1170a71c8` first required `orchestration_mode: "auto"` in the existing production transport regression. Source commit `5a6afdd9f26994987e3d9ba3b85a8dd95f06a7e7` then added the field while preserving the existing fail-closed request boundary. Exact-current-head hosted evidence remains authoritative for merge readiness.

## Rollback

Rollback removes the explicit `orchestration_mode` request field, its regression expectation, this evidence record, the matching production-contract text, and the changelog entry together. Rollback must not restore the discarded self-modifying workflow or stale pre-hardening orchestrator source.

## APA 7th references

Contextual Wisdom Lab. (2026). *contextual-orchestrator* (Commit 6841b71935e0b7cb98fb52bcb4709cc5100c8d87) [Computer software]. GitHub.

Nielsen, S., Cetin, E., Schwendeman, P., Sun, Q., Xu, J., & Tang, Y. (2025). *Learning to orchestrate agents in natural language with the Conductor*. arXiv. https://doi.org/10.48550/arXiv.2512.04388

Sakana AI. (2026). *Sakana Fugu: Multi-agent system as a model*. https://sakana.ai/fugu/

Xu, J., Sun, Q., Schwendeman, P., Nielsen, S., Cetin, E., & Tang, Y. (2025). *TRINITY: An evolved LLM coordinator*. arXiv. https://doi.org/10.48550/arXiv.2512.04695
