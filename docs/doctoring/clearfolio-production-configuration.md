# Clearfolio production configuration boundary

## Decision

ScopeWeave treats Clearfolio as an optional production capability, not as an implicit successful mock. The in-memory converter is available only when `SCOPEWEAVE_DEV=1` and no provider URL is configured. Outside that explicit development boundary, an absent provider produces the stable `clearfolio_not_configured` failure and the mock artifact route is not registered.

A configured production provider must be a root HTTPS origin. ScopeWeave parses the operator value with the platform `URL` implementation and rejects URL credentials, query strings, fragments, and configured paths before building any downstream endpoint. HTTP is limited to explicit development mode on `localhost`, `127.0.0.1`, or `::1`. The tenant-claim HMAC secret is mandatory with a configured provider and must contain at least 32 non-whitespace characters.

This boundary prevents configuration text from becoming an arbitrary downstream request prefix and prevents a production deployment from persisting fake `SUCCEEDED` conversion state merely because an integration is absent. It also preserves independent ScopeWeave operation: planning functionality remains available while document conversion/viewing fails closed with an actionable configuration error.

## Artifact-token origin rule

If Clearfolio returns an `artifactToken`, ScopeWeave rewrites it into the trusted Clearfolio viewer route only when the returned URL has the same origin as the configured Clearfolio service. A token-bearing link from another origin is never transplanted into the trusted viewer. Reviewed CDN or object-storage hosts are added only through the later `CLEARFOLIO_ARTIFACT_ORIGINS` allowlist recorded in `docs/doctoring/clearfolio-artifact-origin-trust.md`; without that setting, a cross-origin token remains rejected.

Issue #489 remains open after this slice. Streaming response-size/media-type limits and the provider-wide request budget are owned by the provider-response-boundary record. Remaining work is capability readiness, persistence/lifecycle controls, incident and recovery evidence, and destination DNS/IP authorization so an allowlisted origin cannot become an arbitrary in-origin redirector.

## Executable evidence

`tests/unit/clearfolio-adapter-mock-hmac.test.mjs` proves:

- production without `CLEARFOLIO_URL` does not enable the mock and fails submit/status/artifact operations closed;
- the mock works only under explicit `SCOPEWEAVE_DEV=1`;
- unsupported schemes, remote HTTP, URL credentials, query strings, fragments, configured paths, and weak HMAC secrets are rejected;
- loopback HTTP is accepted only under explicit development mode; and
- signed tenant headers retain the documented canonical HMAC contract.

`tests/unit/clearfolio-status-signal.test.mjs` continues to exercise sanitized transport/HTTP/JSON/status/artifact failures and now proves that a cross-origin token-bearing artifact link fails closed rather than moving the token into the Clearfolio viewer or returning it to an unreviewed host. `tests/api/attachment-status.test.mjs` makes its test-only in-memory provider explicit instead of relying on an unset production URL.

The shipped `server/clearfolio.mjs` remains in the canonical c8 production coverage target, so the new configuration branches execute under the repository coverage gate rather than a documentation-only path.

## Standards and threat rationale

The WHATWG URL Standard defines URL components, including credentials, queries, and fragments, and provides the common parsing model used by the JavaScript `URL` API. ScopeWeave parses first and then applies component-level policy instead of relying on string-prefix validation.

OWASP's SSRF Prevention guidance recommends strict allowlisting and warns that redirects and attacker-controlled complete URLs can bypass URL validation. This slice narrows operator configuration to a provider origin and keeps request paths adapter-owned. The remaining redirect and artifact-host controls stay explicitly tracked by issue #489 rather than being implied by this narrower change.

NIST SSDF 1.1 recommends identifying and maintaining software security requirements and producing well-secured software through repeatable verification. The fail-closed configuration contract, executable negative tests, and explicit remaining-gap statement provide acquisition-review evidence without claiming certification.

## Rollback

Rollback reverts the Clearfolio configuration parser, explicit development-mode tests, token-origin rule, deployment text, this doctoring record, and the corresponding CHANGELOG entry together. No database schema or persisted attachment representation changes in this slice.

## References

National Institute of Standards and Technology. (2022). *Secure Software Development Framework (SSDF) Version 1.1: Recommendations for mitigating the risk of software vulnerabilities* (NIST Special Publication 800-218). https://doi.org/10.6028/NIST.SP.800-218

OWASP Foundation. (n.d.). *Server Side Request Forgery Prevention Cheat Sheet*. OWASP Cheat Sheet Series. https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

WHATWG. (2026). *URL Standard*. https://url.spec.whatwg.org/
