# Contextual-orchestrator adaptive default

## Status

Active pull-request behavior. This document does not describe protected `develop` until the change is integrated.

## Buyer outcome

ScopeWeave owns the meaning of a planning-analysis request, its authorization boundary, and how the result is presented. The shared `contextual-orchestrator` service owns model/provider selection and the depth of orchestration. ScopeWeave therefore asks for the orchestrator's supported `auto` mode explicitly rather than depending on an implicit gateway default or selecting a provider/model itself.

## Verified dependency contract

The current protected `ContextualWisdomLab/contextual-orchestrator` `main` revision inspected for this slice is `6841b71935e0b7cb98fb52bcb4709cc5100c8d87`.

At that revision, `contextual_orchestrator/server.py`:

- permits `orchestration_mode` on `/v1/chat/completions` requests;
- defines the accepted modes as `auto`, `route`, and `conduct`; and
- retains `model` and `messages` as part of the OpenAI-compatible chat boundary.

That live dependency evidence is the contract used by this ScopeWeave change. This document does not claim that a particular model, provider, worker count, verifier topology, or cost policy will always be selected by `auto`; those choices remain contextual-orchestrator authority and may evolve behind its versioned contract.

## ScopeWeave request contract

For a configured production orchestrator, `server/orchestrator.mjs` sends:

- `model: "contextual-orchestrator"`;
- `orchestration_mode: "auto"`; and
- the caller's already-authorized `messages`.

The client may later add separately reviewed contextual-orchestrator-supported metadata such as server-derived attribution. The regression therefore verifies the required adaptive-mode fields without turning today's complete JSON key set into an accidental frozen protocol.

When no orchestrator URL is configured, ScopeWeave retains its deterministic non-LLM fallback. This slice does not make the application depend on a network service for standalone operation.

## TDD and control-plane repair

The first permanent regression commit required `orchestration_mode: "auto"` while the production client still sent only `model` and `messages`. The production source change followed that regression.

An earlier branch-only workflow attempted to stage tests, mutate production files, delete itself, and push the result with write credentials. That mechanism was removed before the product change because it violated the repository's single-writer and non-self-modifying automation boundary. The product behavior is now represented directly by normal reviewed source/test commits on the existing pull-request branch.

The permanent test suite covers:

- deterministic standalone fallback;
- configured production transport with and without a bearer token;
- explicit `auto` mode and message preservation;
- provider error and malformed-response failure behavior; and
- request-timeout abort wiring.

`server/orchestrator.mjs` and the regression are registered in the canonical owned-production c8 path, and the coverage-script contract prevents either registration from silently disappearing.

## Security and ownership boundary

This change does not send provider credentials, select a provider, broaden network authority, weaken timeout handling, or convert model output into deterministic authorization evidence. The existing `ORCHESTRATOR_URL`/`ORCHESTRATOR_TOKEN` boundary remains unchanged. Deterministic CI, security, coverage, and merge governance remain independent from model judgment.

## Rollback

Rollback removes the explicit `orchestration_mode` field, its permanent transport regression, c8 registration, this evidence record, and the matching changelog entry together. A rollback must not restore the removed self-modifying branch workflow or temporary mutation scripts.

## References

Contextual Wisdom Lab. (2026). *contextual-orchestrator* (Commit 6841b71935e0b7cb98fb52bcb4709cc5100c8d87) [Computer software]. GitHub.
