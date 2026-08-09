# OpenID Connect Production Contract

ScopeWeave is an OpenID Connect Relying Party. Production sign-in requires
provider discovery, Authorization Code flow with S256 PKCE, a cryptographically
bound nonce, and ID Token signature/claim verification. Decoding a JWT payload
without verifying its JWS signature is forbidden.

## Required environment

```text
OIDC_ISSUER=https://identity.example/tenant
OIDC_CLIENT_ID=scopeweave-client
OIDC_CLIENT_SECRET=<secret>
OIDC_REDIRECT_URI=https://scopeweave.example/api/auth/oidc/callback
```

Production fails closed when any value is absent or when issuer, discovery,
token, JWKS, or redirect endpoints violate the HTTPS policy. Loopback HTTP is
accepted only for local development. `SCOPEWEAVE_DEV=1` is the only boundary
that enables the local mock provider and must never be set in staging or
production.

## Verification contract

The relying party performs the following checks before creating a ScopeWeave
session:

1. discovery metadata `issuer` exactly matches `OIDC_ISSUER`;
2. authorization request includes `openid`, high-entropy state, nonce, and S256
   PKCE challenge;
3. callback state is single-use and unexpired;
4. token exchange uses the exact registered redirect URI and PKCE verifier;
5. ID Token uses compact JWS with `alg=RS256` and a matching provider JWKS key;
6. RSA signature is verified over the exact encoded header and claims;
7. `iss`, `aud`, multi-audience `azp`, `exp`, `iat`, optional `nbf`, and nonce
   are validated;
8. `sub` is non-empty and the email claim is explicitly verified;
9. provider responses are bounded and raw token/provider payloads are never
   returned in errors or logs.

## Multi-instance state

Authorization state and nonce must be kept in a single-use server-side store
shared by every API replica before horizontal scaling. A process-local state
map is acceptable only for the current single-node deployment ceiling. The
multi-instance migration must use a two-word database object such as
`oidc_state_records`, an expiry index, atomic consume semantics, and encrypted
or one-way protected verifier/nonce material.

## APA 7th references

Jones, M., & Bradley, J. (2015). *Proof key for code exchange by OAuth public
clients* (RFC 7636). Internet Engineering Task Force.
https://doi.org/10.17487/RFC7636

Jones, M., Bradley, J., & Sakimura, N. (2015). *JSON Web Token (JWT)*
(RFC 7519). Internet Engineering Task Force.
https://doi.org/10.17487/RFC7519

Sakimura, N., Bradley, J., Jones, M., de Medeiros, B., & Mortimore, C. (2023).
*OpenID Connect Core 1.0 incorporating errata set 2*. OpenID Foundation.
https://openid.net/specs/openid-connect-core-1_0.html

Sakimura, N., Bradley, J., Jones, M., & Jay, E. (2023). *OpenID Connect
Discovery 1.0 incorporating errata set 2*. OpenID Foundation.
https://openid.net/specs/openid-connect-discovery-1_0.html
