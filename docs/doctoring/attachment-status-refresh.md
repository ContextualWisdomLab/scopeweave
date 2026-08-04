# Attachment status refresh: evidence and design record

## Decision

Attachment listing is a buyer-visible read path and must remain responsive when
Clearfolio is slow, unavailable, or returns malformed data. ScopeWeave therefore
refreshes only stale conversion states through a reusable bounded worker module
that is independent of Hono and SQLite.

The implementation:

1. includes the internal conversion identifier in the initial project-scoped
   database query, eliminating one lookup per returned row;
2. limits per-request downstream concurrency through a configurable worker pool;
3. applies a caller-side timeout to every Clearfolio request and forwards the
   same `AbortSignal` to `fetch`;
4. applies a wall-clock budget to the complete best-effort refresh pass and
   defers work that cannot start within that budget;
5. validates successful downstream payloads as objects with a nonempty string
   status and validates the status against the local state contract;
6. preserves the previously stored status after timeout, downstream, malformed
   response, invalid state, or persistence failure;
7. persists only changed states;
8. strips internal conversion identifiers before serialization; and
9. publishes attempted, changed, failed, and deferred counters without sensitive
   downstream payloads or identifiers.

## Standards and threat rationale

OWASP API Security Top 10 2023 identifies unrestricted resource consumption as a
risk when APIs do not bound client interactions or resources. The per-request
worker cap, per-item timeout, request-wide budget, and existing endpoint rate
limit are complementary controls: they bound one list operation, one downstream
operation, the complete refresh pass, and repeated client traffic respectively.

OWASP API10:2023 identifies unsafe consumption of third-party APIs when an
integrating service fails to validate returned data, limit processing resources,
or implement timeouts. ScopeWeave therefore treats Clearfolio responses as
untrusted input even after an HTTP success: rejected JSON, null, primitives,
arrays, missing or non-string statuses, empty statuses, and states outside the
allowlist do not update the database.

The worker and validation contract is placed in a framework- and database-neutral
module so a future MSA extraction can reuse the same behavior with another HTTP
adapter or persistence implementation. The monolith remains fully operable on
its own.

## Verification contract

Regression tests must prove:

- one hundred pending rows reach but never exceed configured concurrency;
- task-filtered and project-wide lists share one refresh contract;
- unchanged states are not written;
- downstream, timeout, malformed-response, invalid-state, diagnostic, and write
  failures are isolated to the affected row;
- unstarted work beyond the request budget is counted as deferred;
- downstream response text and internal conversion identifiers never appear in
  client JSON;
- the caller `AbortSignal` reaches Clearfolio;
- all malformed successful payload branches fail closed; and
- the bounded refresh production module retains 100% statement, branch, and
  function coverage with complete production docstrings.

## Operational acceptance

Rollout begins with a canary and conservative concurrency. Operators compare
attachment-list p50, p95, and p99 latency with refresh failure and deferral
ratios. A high failure ratio blocks rollout. A high deferred ratio indicates the
latency budget is containing work at the cost of freshness and requires
Clearfolio latency and list-size diagnosis before increasing resource limits.
Rollback is configuration-first and requires no schema migration.

## References

OWASP Foundation. (2023a). *API4:2023 unrestricted resource consumption*. OWASP
API Security Top 10.
https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/

OWASP Foundation. (2023b). *API10:2023 unsafe consumption of APIs*. OWASP API
Security Top 10.
https://owasp.org/API-Security/editions/2023/en/0xaa-unsafe-consumption-of-apis/
