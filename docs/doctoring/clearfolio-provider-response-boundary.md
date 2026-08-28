# Clearfolio provider response and request boundary

## Decision

ScopeWeave treats the Clearfolio service as an untrusted external API even after its root origin and tenant HMAC configuration have passed the production configuration boundary. Every hosted submit, status, and artifact-link call therefore uses the same fail-closed transport and response rules before provider data can affect ScopeWeave state or browser-visible behavior.

This record is intentionally narrower than the full Clearfolio production-readiness issue. It extends the configuration boundary introduced by the preceding production-configuration slice and does not claim that arbitrary cross-origin artifact delivery, retry/idempotency policy, or the complete provider lifecycle is finished.

## Request contract

Hosted provider requests:

1. use the configuration-validated provider origin and adapter-owned endpoint path;
2. send tenant claims only to that direct origin request;
3. use Fetch `redirect: "error"` so a redirect is a transport failure rather than a credential-forwarding opportunity;
4. carry a hard 15,000 ms total-request `AbortSignal`;
5. compose a caller cancellation signal with that hard budget for status refreshes; and
6. collapse network, redirect, timeout, and cancellation details into fixed operation-level errors before they can reach browser or diagnostic payloads; and
7. preserve the timeout category when the hard budget aborts an in-progress status response body, so refresh metrics distinguish timeouts from malformed responses.

ScopeWeave does not retry provider calls in this slice. Retry eligibility, idempotency keys, backoff, cancellation recovery, and persisted operation lifecycle remain explicit follow-up work rather than being guessed at the transport layer.

## Response contract

Successful provider responses are accepted only when the media type essence is `application/json`. If `Content-Length` is present it must be an exact non-negative decimal integer no greater than 256 KiB. The body stream is independently counted to the same 256 KiB ceiling, so missing or dishonest length metadata cannot bypass the resource limit. Empty bodies, malformed streams, invalid UTF-8, malformed JSON, and incompatible JSON shapes fail closed with fixed operation-specific errors.

The adapter never uses `response.json()` directly for successful hosted provider responses. This prevents an otherwise successful response from being buffered without an application-level byte ceiling before validation.

Provider conversion states remain the exact `PENDING`, `RUNNING`, `SUCCEEDED`, and `FAILED` set. Provider job identifiers are trimmed and limited to 256 characters without control characters before persistence or URL construction.

## Document boundary

Document metadata and bytes are validated before `Blob` or `FormData` construction. The provider adapter accepts only:

- a non-empty document name of at most 512 characters without control characters;
- a MIME string of at most 255 characters without control characters; an empty value retains the existing `application/octet-stream` fallback;
- `Uint8Array`-compatible bytes no larger than 10 MiB.

The 10 MiB limit matches the current ScopeWeave attachment API ceiling, so the downstream adapter cannot accept a document larger than the application path that feeds it.

## Artifact boundary and remaining work

The preceding slice already prevents a cross-origin `artifactToken` from being transplanted into the trusted Clearfolio viewer origin. This slice bounds and media-validates the artifact-link response itself and disables redirects on the request.

It **does not yet approve arbitrary cross-origin artifact URLs**. Issue #489 still owns the reviewed artifact-origin allowlist and the remaining URL rules for returned links, including credential and fragment rejection. Until that later slice integrates, cross-origin artifact URLs retain the narrower predecessor behavior and must not be represented as a fully qualified production CDN/object-storage policy.

## Verification contract

Regression evidence covers:

- `redirect: "error"` on submit, status, and artifact-link calls;
- hard request-budget signals and caller-signal composition;
- non-JSON media rejection;
- declared and streamed response-size overflow;
- cancellation-detail sanitization;
- document metadata/byte rejection before provider transport;
- oversized provider job identifiers before URL construction;
- valid streamed JSON compatibility for submission, status, HMAC, loopback-development, and artifact-link behavior;
- the predecessor configuration, HMAC, artifact-token-origin, sanitized-error, status-enum, and attachment-refresh contracts under the same normal unit/coverage paths.

`server/clearfolio.mjs` remains an owned c8 production target. The new provider-boundary regression is registered in both `test:unit` and `test:coverage:cases`; exact statement, branch, function, and line evidence remains a merge gate rather than a documentation claim.

## Security rationale

OWASP API10:2023 identifies unsafe consumption of third-party APIs when applications trust integrated-service data, blindly follow redirects, fail to validate returned data, omit timeouts, or fail to limit resources used to process third-party responses. OWASP API4:2023 separately highlights unbounded memory, bandwidth, and execution-time consumption. The transport, timeout, media-type, streaming-byte, identifier, and document limits in this slice apply those controls at the provider boundary rather than relying on Clearfolio to behave correctly.

The WHATWG Fetch Standard explicitly supports `redirect: "error"` to reject redirect responses. ScopeWeave uses that mode because tenant HMAC claims are provider-origin credentials and there is no reviewed redirect allowlist in the current protocol.

Node.js 22 provides `AbortSignal.timeout()` and `AbortSignal.any()`, allowing the adapter to impose its own total request budget while preserving upstream cancellation without maintaining a second timer/cancellation protocol.

## Rollback

Rollback reverts the provider-boundary implementation, the new and adapted unit regressions, test registrations, deployment guidance, this doctoring record, and the CHANGELOG entry together. The slice adds no database schema or migration. Existing persisted attachment state remains readable by the predecessor implementation.

## References

Node.js contributors. (2026). *Global objects: AbortSignal*. Node.js documentation. Retrieved August 15, 2026, from https://nodejs.org/download/release/v22.18.0/docs/api/globals.html

OWASP Foundation. (2023a). *API4:2023 unrestricted resource consumption*. OWASP API Security Top 10. https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/

OWASP Foundation. (2023b). *API10:2023 unsafe consumption of APIs*. OWASP API Security Top 10. https://owasp.org/API-Security/editions/2023/en/0xaa-unsafe-consumption-of-apis/

WHATWG. (2026). *Fetch Standard* (Living Standard, updated May 8, 2026). https://fetch.spec.whatwg.org/
