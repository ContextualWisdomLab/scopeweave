# Clearfolio production configuration boundary

## Decision

ScopeWeave treats Clearfolio as an optional production capability, not as an implicit successful mock. The in-memory converter is available only when `SCOPEWEAVE_DEV=1` and no provider URL is configured. Outside that explicit development boundary, an absent provider produces the stable `clearfolio_not_configured` failure and the mock artifact route is not registered.

A configured production provider must be a root HTTPS origin. ScopeWeave parses the operator value with the platform `URL` implementation and rejects URL credentials, query strings, fragments, and configured paths before building any downstream endpoint. HTTP is limited to explicit development mode on `localhost`, `127.0.0.1`, or `[::1]`. The tenant-claim HMAC secret is mandatory with a configured provider and must contain at least 32 non-whitespace characters. Surrounding whitespace, including a trailing newline from a secret file, is trimmed before length checking and signing so the adapter and Clearfolio verify the same key.

This boundary prevents configuration text from becoming an arbitrary downstream request prefix and prevents a production deployment from persisting fake `SUCCEEDED` conversion state merely because an integration is absent. It also preserves independent ScopeWeave operation: planning functionality remains available while document conversion/viewing fails closed with an actionable configuration error.

## Artifact-token origin rule

Returned artifact links must share the configured Clearfolio origin. Same-origin `artifactToken` values are rewritten into the trusted Clearfolio viewer route. A cross-origin link — with or without a token — is rejected rather than transplanted into the trusted viewer or returned through the attachment-view 302. Credentials and fragments on the returned link are also rejected. This fail-closed default does not invent a CDN allowlist; operators who later need object-storage hosts must land an explicit reviewed allowlist in a later #489 slice.

## Provider redirect rule

Clearfolio submit, status, and artifact-link `fetch` calls set `redirect: 'error'`. The Fetch default follows redirects and would replay tenant HMAC headers onto a `Location` host because those headers are not forbidden. A 3xx from the pinned origin therefore fails closed with the existing sanitized transport error instead of leaking tenant, subject, permissions, issued-at, or the signature.

Issue #489 remains open after this slice. A subsequent bounded change must still implement the explicit reviewed artifact-origin allowlist, streaming response-size/media-type limits, provider-wide request budget, and the remaining resource/lifecycle acceptance criteria before the Clearfolio adapter can be described as fully production-complete.

## Executable evidence

`tests/unit/clearfolio-adapter-mock-hmac.test.mjs` proves:

- production without `CLEARFOLIO_URL` does not enable the mock and fails submit/status/artifact operations closed;
- the mock works only under explicit `SCOPEWEAVE_DEV=1`;
- unsupported schemes, remote HTTP (including under `SCOPEWEAVE_DEV=1`), URL credentials, query strings, fragments, configured paths, and weak HMAC secrets are rejected;
- loopback HTTP is accepted only under explicit development mode;
- a secret-file trailing newline is trimmed before HMAC signing; and
- signed tenant headers retain the documented canonical HMAC contract and set `redirect: 'error'`.

`tests/unit/clearfolio-status-signal.test.mjs` continues to exercise sanitized transport/HTTP/JSON/status/artifact failures and now proves that a redirect `TypeError`, a token-bearing or token-free cross-origin artifact link, a protocol-relative host, and credentialed or fragmented same-origin links fail closed rather than moving a token into the Clearfolio viewer or returning an unreviewed 302 target. `tests/api/attachment-status.test.mjs` makes its test-only in-memory provider explicit instead of relying on an unset production URL.

The shipped `server/clearfolio.mjs` remains in the canonical c8 production coverage target, so the new configuration branches execute under the repository coverage gate rather than a documentation-only path.

## Standards and threat rationale

The WHATWG URL Standard defines URL components, including credentials, queries, and fragments, and provides the common parsing model used by the JavaScript `URL` API. ScopeWeave parses first and then applies component-level policy instead of relying on string-prefix validation.

OWASP's SSRF Prevention guidance recommends strict allowlisting and warns that redirects and attacker-controlled complete URLs can bypass URL validation. This slice narrows operator configuration to a provider origin, keeps request paths adapter-owned, refuses to follow provider redirects, and refuses unreviewed artifact hosts. The remaining artifact-host allowlist, streaming body limits, and request-budget controls stay explicitly tracked by issue #489.

NIST SSDF 1.1 recommends identifying and maintaining software security requirements and producing well-secured software through repeatable verification. The fail-closed configuration contract, executable negative tests, and explicit remaining-gap statement provide acquisition-review evidence without claiming certification.

## Rollback

Rollback reverts the Clearfolio configuration parser, explicit development-mode tests, same-origin artifact rule, `redirect: 'error'` provider fetches, HMAC secret trimming, deployment text, this doctoring record, and the corresponding CHANGELOG entry together. No database schema or persisted attachment representation changes in this slice. After rollback, production again follows provider redirects with tenant HMAC headers and can 302 a browser to an unreviewed artifact host.

## References

National Institute of Standards and Technology. (2022). *Secure Software Development Framework (SSDF) Version 1.1: Recommendations for mitigating the risk of software vulnerabilities* (NIST Special Publication 800-218). https://doi.org/10.6028/NIST.SP.800-218

OWASP Foundation. (n.d.). *Server Side Request Forgery Prevention Cheat Sheet*. OWASP Cheat Sheet Series. https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

WHATWG. (2026). *URL Standard*. https://url.spec.whatwg.org/
