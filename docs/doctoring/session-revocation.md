# Session JWT revocation: evidence and design record

## Decision

Every ScopeWeave transport that accepts a general session JWT uses one
fail-closed verifier. Bearer middleware, calendar feeds, server-sent events, and
attachment-view routes therefore share signature, header, claim, subject, expiry,
and database-backed revocation checks.

The implementation:

1. pins the compact token to an authenticated `HS256` signature and signed `JWT`
   type;
2. authenticates the compact representation before interpreting the JOSE header
   or claim set;
3. requires a non-array claims object, positive safe-integer subject, future
   safe-integer expiry, and non-negative safe-integer token version;
4. requires the subject to exist and compares the signed token version exactly
   with the current persisted version;
5. rejects malformed, forged, expired, missing-user, and stale sessions before
   tenant or resource lookup;
6. caps general session minting at seven days and rejects fractional, unsafe,
   non-positive, or longer lifetimes; and
7. reserves narrower and shorter authority for the opaque access-grant design in
   issue #413 rather than overloading the general session JWT.

## Standards rationale

RFC 7519 defines a JWT claims set as a JSON object and defines `sub` and `exp` as
registered claims. ScopeWeave narrows those flexible JSON representations to
safe integers because its database identifiers and token-version comparisons are
integer security boundaries.

RFC 8725 requires callers to perform algorithm verification, validate every
cryptographic operation, use explicit typing for new JWT uses, and apply mutually
exclusive validation rules where different token kinds coexist. ScopeWeave pins
one algorithm and one type for general sessions and does not reuse this JWT
contract for the scoped URL grants planned in issue #413.

RFC 6750 explains that any holder of a bearer token can exercise its authority,
recommends short-lived and audience-scoped credentials, and warns against page
URL transport because browser history and server logs can expose tokens. RFC
9700 updates OAuth security best current practice and prohibits clients from
passing access tokens in URI query parameters. This pull request does not claim
to remove the existing URL transport; it makes revocation and validation
consistent until issue #413 replaces those general credentials with narrowly
scoped opaque grants and separately revocable calendar subscription secrets.

## Verification contract

Regression tests must prove:

- the signer rejects invalid subject, token version, fractional lifetime,
  numerically unsafe lifetime, and any general-session lifetime over seven days;
- malformed compact tokens, signatures, JOSE headers, claim-set shapes, subjects,
  expiries, and token-version values fail across every transport;
- a correctly signed token for a nonexistent subject fails before resource
  lookup;
- two independently minted device sessions work before revocation;
- `logout-all` invalidates both stale sessions on bearer, calendar, SSE, and
  attachment-view paths; and
- the replacement session continues through the same authentication boundary.

All changed production helpers require complete JSDoc and 100% statement,
branch, function, and line coverage before the pull request can leave Draft.

## References

Jones, M., Bradley, J., & Sakimura, N. (2015). *JSON Web Token (JWT)* (RFC
7519). Internet Engineering Task Force. https://doi.org/10.17487/RFC7519

Jones, M. B., & Hardt, D. (2012). *The OAuth 2.0 authorization framework:
Bearer token usage* (RFC 6750). Internet Engineering Task Force.
https://doi.org/10.17487/RFC6750

Lodderstedt, T., Bradley, J., Labunets, A., & Fett, D. (2025). *Best current
practice for OAuth 2.0 security* (BCP 240; RFC 9700). Internet Engineering Task
Force. https://doi.org/10.17487/RFC9700

Sheffer, Y., Hardt, D., & Jones, M. (2020). *JSON Web Token best current
practices* (BCP 225; RFC 8725). Internet Engineering Task Force.
https://doi.org/10.17487/RFC8725
