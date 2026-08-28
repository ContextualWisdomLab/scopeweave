# Clearfolio production configuration boundary

## Decision

ScopeWeave treats Clearfolio as an optional production capability, not as an implicit successful mock. The in-memory converter is available only when `SCOPEWEAVE_DEV=1` and no provider URL is configured. Outside that explicit development boundary, an absent provider produces the stable `clearfolio_not_configured` failure and the mock artifact route is not registered.

A configured production provider must be a root HTTPS origin. ScopeWeave parses the operator value with the platform `URL` implementation and rejects URL credentials, query strings, fragments, and configured paths before building any downstream endpoint. HTTP is limited to explicit development mode on `localhost`, `127.0.0.1`, or `::1`. The tenant-claim HMAC secret is mandatory with a configured provider and must contain at least 32 non-whitespace characters.

This boundary prevents configuration text from becoming an arbitrary downstream request prefix and prevents a production deployment from persisting fake `SUCCEEDED` conversion state merely because an integration is absent. It also preserves independent ScopeWeave operation: planning functionality remains available while document conversion/viewing fails closed with an actionable configuration error.

## Provider redirect and artifact-origin rule

Every tenant-signed submit, status, and artifact-link fetch uses `redirect: "error"`. A provider redirect therefore becomes the existing sanitized transport failure instead of allowing the runtime to replay tenant HMAC headers onto an untrusted `Location` target.

Artifact links are default-deny outside the configured Clearfolio origin. They must contain no URL credentials or fragment. Protocol-relative or absolute foreign-host links therefore fail closed unless the foreign origin has been explicitly admitted by the reviewed `CLEARFOLIO_ARTIFACT_ORIGINS` policy described in `docs/doctoring/clearfolio-artifact-origin-trust.md`. Allowlist entries themselves must be canonical origin values so ambiguous path, credential, fragment, and serialization variants cannot silently broaden authority.

If a same-origin link contains an `artifactToken`, ScopeWeave rewrites that token into the trusted Clearfolio viewer route. A token is never transplanted from one origin into another. When a reviewed cross-origin artifact origin is explicitly allowed, its token-bearing URL remains bound to that issuing origin rather than being rewritten into the Clearfolio viewer.

Issue #489 remains open after this stack. The provider-response parent owns bounded request time, response media type/size, streamed JSON parsing, and response-body cleanup. Remaining work includes capability readiness, broader persistence/lifecycle and incident/recovery evidence, plus destination DNS/IP authorization and any stronger signed-artifact URL-shape restrictions required for allowlisted origins.

## Executable evidence

`tests/unit/clearfolio-adapter-mock-hmac.test.mjs` proves:

- production without `CLEARFOLIO_URL` does not enable the mock and fails submit/status/artifact operations closed;
- the mock works only under explicit `SCOPEWEAVE_DEV=1`;
- unsupported schemes, remote HTTP, URL credentials, query strings, fragments, configured paths, and weak HMAC secrets are rejected;
- loopback HTTP is accepted only under explicit development mode; and
- signed tenant headers retain the documented canonical HMAC contract.

`tests/unit/clearfolio-status-signal.test.mjs` preserves the parent transport/HTTP/JSON/status/artifact regressions and requires all three tenant-signed fetch paths to disable redirects. With no artifact-origin allowlist it rejects token-free foreign HTTPS links, protocol-relative foreign links, credential-bearing same-origin links, fragmented same-origin links, and cross-origin token-bearing links while retaining same-origin relative links and the trusted viewer rewrite. With an explicit canonical `CLEARFOLIO_ARTIFACT_ORIGINS` entry it permits that exact foreign origin and leaves a foreign-origin token bound to its issuing URL. `tests/api/attachment-status.test.mjs` keeps its test-only in-memory provider explicit instead of relying on an unset production URL.

The shipped `server/clearfolio.mjs` remains in the canonical c8 production coverage target, so the configuration, provider-response, and allowlist branches execute under the repository coverage gate rather than a documentation-only path.

## Standards and threat rationale

The WHATWG URL Standard defines URL components, credentials, origins, queries, fragments, and serialization behavior used by the JavaScript `URL` API. ScopeWeave parses first and then applies component-level and canonical-origin policy instead of relying on string-prefix validation.

OWASP's SSRF Prevention guidance recommends strict allowlisting and warns that redirects and attacker-controlled complete URLs can bypass URL validation. ScopeWeave narrows operator configuration to a provider origin, disables redirect following for tenant-signed calls, defaults artifact redirects to the provider origin, and admits a foreign artifact origin only through explicit canonical allowlisting. DNS/IP destination authorization remains a separately tracked defense-in-depth boundary rather than being implied by hostname allowlisting.

NIST SSDF 1.1 recommends identifying and maintaining software security requirements and producing well-secured software through repeatable verification. The fail-closed configuration contract, executable negative tests, and explicit remaining-gap statement provide acquisition-review evidence without claiming certification.

## Rollback

Rolling back the artifact-origin child removes its allowlist parsing, allowlist-specific tests/docs/deployment text, and child CHANGELOG entries while retaining the parent provider-configuration, redirect prohibition, same-origin default, bounded-response, and request-budget controls. No database schema or persisted attachment representation changes in this slice.

## References

National Institute of Standards and Technology. (2022). *Secure Software Development Framework (SSDF) Version 1.1: Recommendations for mitigating the risk of software vulnerabilities* (NIST Special Publication 800-218). https://doi.org/10.6028/NIST.SP.800-218

OWASP Foundation. (n.d.). *Server Side Request Forgery Prevention Cheat Sheet*. OWASP Cheat Sheet Series. https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

WHATWG. (2026). *URL Standard*. https://url.spec.whatwg.org/
