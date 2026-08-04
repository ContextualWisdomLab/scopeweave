# Attachment status refresh and Clearfolio boundary: evidence and design record

## Decision

Attachment listing is a buyer-visible read path and must remain responsive when
Clearfolio is slow, unavailable, or returns malformed data. ScopeWeave therefore
refreshes only stale conversion states through a reusable bounded worker module
that is independent of Hono and SQLite. The Clearfolio HTTP adapter separately
owns downstream transport, tenant headers, response-shape validation, and
artifact-link validation.

The implementation:

1. includes the internal conversion identifier in the initial project-scoped
   database query, eliminating one lookup per returned row;
2. limits per-request downstream concurrency through a configurable worker pool;
3. applies a caller-side timeout to every Clearfolio request and forwards the
   same `AbortSignal` to `fetch`;
4. applies a wall-clock budget to the complete best-effort refresh pass and
   defers valid work that cannot start within that budget;
5. counts pending rows with absent or blank conversion identifiers as skipped
   data-quality cases rather than misclassifying them as latency deferrals;
6. validates conversion states against the exact `PENDING`, `RUNNING`,
   `SUCCEEDED`, and `FAILED` contract rather than trimming or accepting unknown
   strings;
7. preserves the previously stored status after timeout, transport, HTTP,
   malformed-response, invalid-state, diagnostic, or persistence failure;
8. persists only changed states;
9. strips internal conversion identifiers before serialization;
10. publishes attempted, changed, failed, skipped, and deferred counters without
    sensitive downstream payloads or identifiers;
11. publishes fixed timeout, downstream-lookup, invalid-status, and persistence
    failure counters so operators can distinguish failure modes without labels or
    raw diagnostic data;
12. replaces raw network and downstream response messages with fixed
    operation-level submission, status, and artifact-link errors;
13. validates successful submission and artifact-link JSON before property use;
14. accepts artifact links only when they resolve to HTTP(S), and prevents an
    HTTPS Clearfolio deployment from returning an HTTP downgrade link; and
15. keeps the in-memory development adapter and HMAC tenant-claim contract under
    focused tests so MSA extraction cannot silently change interoperability.

## Standards and threat rationale

OWASP API Security Top 10 2023 identifies unrestricted resource consumption as a
risk when APIs do not bound client interactions or resources. The per-request
worker cap, per-item timeout, request-wide budget, and existing endpoint rate
limit are complementary controls: they bound one list operation, one downstream
operation, the complete refresh pass, and repeated client traffic respectively.

OWASP API10:2023 identifies unsafe consumption of third-party APIs when an
integrating service fails to validate returned data, limit processing resources,
or implement timeouts. ScopeWeave therefore treats Clearfolio responses as
untrusted input even after HTTP success. Rejected JSON, null, primitives,
arrays, missing or non-string fields, empty or whitespace-padded states, unknown
states, malformed links, unsupported URI schemes, and HTTPS downgrade links fail
closed without changing persisted attachment state.

The browser-facing API may serialize adapter errors, so the adapter never copies
DNS names, socket errors, downstream response text, private URLs, or parser
messages into thrown errors. Operation name and HTTP status are the maximum
external diagnostic detail. The refresh engine records only four fixed failure
categories. Detailed downstream diagnostics belong in a separately redacted
operator channel, not a client response, metric label, audit payload, or trace
attribute.

The worker and validation contract is placed in framework- and database-neutral
modules so a future MSA extraction can reuse the same behavior with another HTTP
adapter or persistence implementation. The monolith remains fully operable on
its own. Adapters must pass the same contract suite before they are considered
substitutable.

## Verification contract

Regression tests must prove:

- one hundred pending rows reach but never exceed configured concurrency;
- task-filtered and project-wide lists share one refresh contract;
- unchanged states are not written;
- downstream, timeout, malformed-response, invalid-state, diagnostic, and write
  failures are isolated to the affected row;
- pending rows with missing conversion identifiers are counted as skipped;
- valid unstarted work beyond the request budget is counted as deferred;
- skipped and deferred metrics remain distinct in JSON and Prometheus output;
- the four failure-category counters sum to the aggregate failure count and
  never contain raw errors, identifiers, URLs, or downstream response text;
- downstream response text, network details, and internal conversion identifiers
  never appear in client JSON;
- the caller `AbortSignal` reaches Clearfolio;
- submission, status, and artifact-link non-success responses expose only fixed
  operation-level errors;
- rejected JSON and every malformed successful payload branch fail closed;
- relative and absolute HTTPS links, artifact-token viewer links, and explicitly
  configured local HTTP links remain supported;
- HTTPS-to-HTTP downgrade and non-HTTP(S) links are rejected;
- the mock adapter preserves uploaded bytes and status semantics;
- HMAC tenant claims use the documented newline-delimited canonical payload;
- the bounded refresh production module retains 100% statement, branch,
  function, and line coverage; and
- every new shipped symbol has complete beginner-readable JSDoc.

## Operational acceptance

Rollout begins with a canary and conservative concurrency. Operators compare
attachment-list p50, p95, and p99 latency with refresh failure, skipped, and
deferral ratios. A high failure ratio blocks rollout and the fixed category
counters identify whether the dominant cause is timeout, downstream lookup,
invalid state, or persistence. A non-zero skipped ratio indicates a persistence
or migration defect and is investigated independently of latency. A high
deferred ratio indicates the latency budget is containing work at the cost of
freshness and requires Clearfolio latency and list-size diagnosis before
increasing resource limits. Rollback is configuration-first and requires no
schema migration.

The rollout review also samples client error payloads, structured logs, traces,
audit exports, and alert annotations to prove that Clearfolio response bodies,
internal DNS names, signed links, HMAC material, and conversion identifiers are
absent. Horizontal replica count is multiplied by configured per-request
concurrency when assessing the downstream connection budget.

## References

OWASP Foundation. (2023a). *API4:2023 unrestricted resource consumption*. OWASP
API Security Top 10.
https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/

OWASP Foundation. (2023b). *API10:2023 unsafe consumption of APIs*. OWASP API
Security Top 10.
https://owasp.org/API-Security/editions/2023/en/0xaa-unsafe-consumption-of-apis/
