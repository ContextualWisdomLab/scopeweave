# ScopeWeave security invariants

ScopeWeave treats the following controls as release-blocking invariants. A change that weakens one of these controls must include an explicit threat-model update and regression coverage.

## Authentication and signing keys

- `SCOPEWEAVE_JWT_SECRET` is mandatory at process startup.
- The secret must contain at least 32 non-whitespace characters and must not be an unexpanded environment placeholder.
- Production deployments must restore the same secret across restarts. Rotating it is an intentional operation because all existing JWTs become invalid.
- Password verification rejects non-string candidate values before hashing or comparison.

## Session revocation

Bearer-token middleware and every endpoint that accepts a JWT through another transport must compare the token's `tv` claim with the user's current database `token_version`.

## Transport security

- The production runtime owns explicit security-response-header values rather than inheriting mutable framework defaults.
- ScopeWeave emits host-only HSTS (`Strict-Transport-Security: max-age=15552000`) by default.
- `includeSubDomains` is a deployment-scope decision, not a generic application default. Set `SCOPEWEAVE_HSTS_INCLUDE_SUBDOMAINS=1` only after proving every current and future descendant host in that domain is HTTPS-capable and under the deployment's certificate/routing ownership.
- A shared apex, customer-managed namespace, or known HTTP-only descendant must not be placed under ScopeWeave's subdomain HSTS policy.
- The TLS terminator must preserve the application HSTS header or own an equivalent deterministic policy. See `docs/deploy.md` and `docs/doctoring/hsts-deployment-scope.md` for rollout evidence and operator acceptance.

## Spreadsheet exports

Every user-controlled CSV cell is neutralized when, after optional leading whitespace, it begins with `=`, `+`, `-`, `@`, or `|`. Export code must not rely on callers to sanitize values.

## XML imports

Microsoft Project XML extraction uses bounded `indexOf`/`slice` loops. Opening and closing `Task`, `PredecessorLink`, and scalar tags accept only XML whitespace (space, tab, carriage return, or line feed) between the exact element name and `>`. Attributes, longer names, and other whitespace code points are not accepted by this deliberately narrow import profile. Dynamic regular expressions and lazy whole-document block collectors are prohibited because truncated or adversarial input can cause catastrophic backtracking.

## Release verification

Before merging security-sensitive changes, the current head must pass:

- unit and API tests;
- cloud UI end-to-end tests;
- property fuzzing;
- dependency and OSV review;
- Semgrep and repository security scans;
- required independent review gates, including coverage evidence.
