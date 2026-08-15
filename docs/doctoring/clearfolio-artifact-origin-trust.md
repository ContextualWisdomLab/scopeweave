# Clearfolio artifact-origin trust boundary

## Decision

ScopeWeave treats every artifact link returned by Clearfolio as untrusted provider data. The configured `CLEARFOLIO_URL` origin is the default artifact trust boundary. A production operator may add reviewed CDN or object-storage origins through `CLEARFOLIO_ARTIFACT_ORIGINS`, but each entry must be an origin only: HTTPS scheme, host, and optional non-default port, with no credentials, path, query, fragment, or empty comma-separated entry.

This slice is deliberately narrower than the complete Clearfolio production-adapter program in issue #489. It does not claim that provider DNS/IP authorization, artifact content validation, retention, or all operational acceptance work is complete. It closes the redirect-origin and token-confusion boundary on top of the provider-response controls owned by the parent PR.

## Why exact origins

RFC 6454 defines an origin around scheme, host, and port. Comparing canonical URL origins therefore keeps `https://cdn.example`, `https://cdn.example:8443`, and HTTP variants in distinct trust domains instead of relying on string-prefix matching. The WHATWG URL Standard supplies the parser and serialization semantics used by Node's `URL` implementation, including explicit username/password and fragment components.

The adapter uses a positive allowlist rather than accepting any syntactically valid HTTPS URL. OWASP's SSRF guidance recommends allowlisting known destinations and disabling or tightly validating redirects when the intended service set is known. Although ScopeWeave is redirecting a browser to a provider-selected artifact rather than issuing a second server-side fetch, the same positive-trust principle prevents an untrusted provider response from turning the application into an arbitrary external redirector.

## Runtime contract

1. `CLEARFOLIO_ARTIFACT_ORIGINS` is optional. When absent, only the validated Clearfolio provider origin is trusted.
2. When present, the value is a comma-separated list of canonicalizable HTTPS origins. Whitespace around entries is ignored; empty entries are rejected.
3. Any malformed entry, HTTP entry, URL credential, path, query, or fragment produces `ClearfolioConfigurationError` with stable code `clearfolio_artifact_origins_invalid` before the artifact-link provider request is sent.
4. Provider-returned artifact URLs must still satisfy the existing HTTP/HTTPS and downgrade rules, must contain no credentials or fragment, and must resolve to the provider origin or an explicitly configured artifact origin.
5. A same-origin `artifactToken` may be translated into the trusted Clearfolio viewer route. A token on an approved cross-origin artifact URL remains on that returned URL; ScopeWeave never transplants it into the provider-origin viewer.
6. Exact origin comparison includes the effective port. Approving `https://cdn.example:8443` does not approve `https://cdn.example`.

## Operator action

If Clearfolio returns artifacts from a separate reviewed CDN or object-storage service, configure only that service origin, for example:

```text
CLEARFOLIO_ARTIFACT_ORIGINS=https://artifacts.example.com,https://archive.example.com:8443
```

Do not place signed paths, object keys, tokens, credentials, query strings, or fragments in this setting. If no cross-origin artifact service is required, leave the variable unset; the provider origin remains the least-privilege default.

## Verification contract

`tests/unit/clearfolio-artifact-origin.test.mjs` exercises the production adapter with real `URL` parsing and a bounded mocked provider response. It proves:

- cross-origin HTTPS artifacts fail by default;
- same-origin relative artifacts continue to resolve against the provider;
- an explicitly approved origin succeeds only for the same scheme/host/port identity;
- approved cross-origin `artifactToken` values remain on the approved origin;
- credentials and fragments are rejected on provider and approved origins;
- malformed, HTTP, credentialed, path-, query-, fragment-bearing, and empty-entry configuration fails before any provider transport.

The test is registered in both the normal unit suite and the production coverage cases so changes to this boundary cannot silently bypass repository coverage evidence.

## Failure and rollback

Configuration failure is fail-closed and limited to the artifact-link capability; it does not broaden trust or silently fall back to arbitrary URLs. Rollback removes the additional-origin feature and returns to provider-origin-only artifact redirects. Do not roll back by permitting arbitrary HTTPS destinations or by moving cross-origin tokens into a trusted same-origin viewer URL.

## References

Barth, A. (2011). *The web origin concept* (RFC 6454). Internet Engineering Task Force. https://doi.org/10.17487/RFC6454

Open Worldwide Application Security Project. (n.d.). *Server side request forgery prevention cheat sheet*. OWASP Cheat Sheet Series. Retrieved August 15, 2026, from https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

WHATWG. (2026). *URL standard*. https://url.spec.whatwg.org/
