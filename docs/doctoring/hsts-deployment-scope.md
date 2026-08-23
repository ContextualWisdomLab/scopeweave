# HSTS deployment scope

**Status:** Active pull-request evidence for #576. This decision is not protected-`develop` shipped truth until the pull request is integrated.

## Problem

ScopeWeave's runtime response-header policy previously emitted
`Strict-Transport-Security: max-age=15552000; includeSubDomains` unconditionally.
The repository's deployment contract supports reverse-proxied SaaS deployments,
custom/shared domains, and environments where the repository cannot prove that
every descendant host is HTTPS-capable. In that context, unconditional
`includeSubDomains` extends a persistent browser policy outside the exact
ScopeWeave origin and can make an HTTP-only descendant unreachable.

## Decision

Keep HSTS enabled by default but scope it to the exact ScopeWeave host:

```text
Strict-Transport-Security: max-age=15552000
```

Operators may opt into descendant-host coverage by setting
`SCOPEWEAVE_HSTS_INCLUDE_SUBDOMAINS=1` only after inventorying the deployment
domain and confirming that every current and future subdomain is served over
HTTPS with valid certificate and proxy routing. The application then emits:

```text
Strict-Transport-Security: max-age=15552000; includeSubDomains
```

This preserves transport hardening without pretending ScopeWeave owns a wider
DNS/TLS boundary than the deployment evidence establishes. Preload is not
enabled by this change.

## Regression contract

`tests/api/security-headers.test.mjs` exercises both HSTS policy branches and
requires host-only HSTS on successful, not-found, static-module, delegated
not-found, and delegated server-error response paths. The regression was first
introduced against the old production behavior and failed because the policy
builder did not exist; the smallest production repair added the explicit policy
builder and deployment opt-in.

Current repository CI is still not merge authority by itself when a workflow
checks out GitHub's synthetic `refs/pull/.../merge` commit instead of the exact
contributor head. The HSTS regression therefore supplies behavior evidence, not
a substitute for the repository's exact-head and independent-review gates.

## Operator acceptance

Before setting `SCOPEWEAVE_HSTS_INCLUDE_SUBDOMAINS=1`:

1. enumerate the exact registrable/apex domain and every descendant host that
   browsers could reach under the proposed HSTS scope;
2. prove HTTPS availability, certificate validity, and TLS routing for each
   current descendant and establish an ownership rule for future descendants;
3. verify that the TLS terminator preserves the application HSTS header or owns
   an equivalent deterministic policy;
4. canary the change on the intended production hostname and confirm that no
   required HTTP-only descendant exists; and
5. retain a rollback plan that accounts for browser-side HSTS persistence until
   `max-age` expires.

Do not use `includeSubDomains` on a shared apex or customer-managed namespace
whose descendants ScopeWeave does not control.

## Evidence basis

MDN documents `includeSubDomains` as optional and states that it extends HSTS to
all subdomains. Its TLS implementation guide recommends careful testing because
the directive can disable subdomains that do not yet support HTTPS. OWASP
likewise describes `includeSubDomains` as appropriate when all present and
future subdomains use HTTPS and warns that it otherwise blocks HTTP-only pages.
These sources support explicit deployment-scope ownership rather than an
unconditional application default.

## References

MDN contributors. (2026, April 23). *Strict-Transport-Security header*. MDN Web Docs. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security

MDN contributors. (n.d.). *Transport Layer Security (TLS) configuration*. MDN Web Docs. Retrieved August 23, 2026, from https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/TLS

OWASP Foundation. (n.d.). *HTTP Strict Transport Security Cheat Sheet*. OWASP Cheat Sheet Series. Retrieved August 23, 2026, from https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Strict_Transport_Security_Cheat_Sheet.html
