# Stripe Checkout provider trust boundary

Status: **active stacked PR design/implementation evidence; not protected-`develop`
shipped truth until its parent and this slice are independently approved and
integrated.**

## Buyer-visible failure being closed

The trusted-origin billing slice prevents request authority from controlling
success/cancel redirects, but a provider boundary also has to constrain how long
Checkout can block a request, whether an unsafe automatic retry can duplicate a
side effect, what provider-returned URL the browser may follow, and what failure
detail can leave the server.

Without those controls a buyer cannot distinguish a controlled billing outage
from an indefinite provider wait, and a compromised or malformed provider
response could become redirect authority.

## Decision

ScopeWeave uses a small, explicit HTTPS adapter for this bounded Checkout call
instead of an undeclared runtime SDK. The adapter follows Stripe's published REST
contract and keeps the production dependency surface auditable.

For hosted Stripe Checkout, this slice applies these controls:

1. The server sends exactly one `POST https://api.stripe.com/v1/checkout/sessions`
   attempt using `application/x-www-form-urlencoded` request data. The request has
   a 15,000 ms total abort budget and redirects are rejected by the fetch layer.
2. ScopeWeave implements no provider retry loop until durable checkout-attempt
   identifiers and idempotency state exist. A later lifecycle slice may introduce
   retries only together with that durable reconciliation model.
3. A non-2xx provider response or network/abort failure becomes stable HTTP 502
   `billing_provider_unavailable`. The provider body is not exposed to callers.
4. A successful response must declare JSON and parse as JSON. Malformed or
   unsupported successful response media becomes stable HTTP 502
   `billing_provider_invalid_response`.
5. The returned Checkout Session `url` is parsed with the platform `URL` parser
   and accepted only when it uses HTTPS, has exact hostname
   `checkout.stripe.com`, uses the default HTTPS port, and contains no URL
   credentials. Provider-issued fragments are preserved verbatim because Stripe's
   Checkout Session examples include opaque client fragments; fragments do not
   participate in HTTPS authority selection.
6. All provider-facing buyer errors use `Cache-Control: no-store` and omit
   downstream exception text, network addresses, response bodies, and secrets.

The validation uses exact parsed authority fields rather than string-prefix or
suffix matching, so `checkout.stripe.com.evil.example` is not trusted.

## Authentication and wire contract

Stripe's API requires HTTPS and authenticates secret API calls with an API key.
Its API reference permits bearer authorization for HTTP clients. ScopeWeave sends
`Authorization: Bearer <STRIPE_SECRET_KEY>` only to the constant Stripe API
origin and never derives that origin from request input. Checkout parameters are
form encoded using the same field names documented by Stripe, including
`line_items[0][price]`, `line_items[0][quantity]`, `success_url`, `cancel_url`,
`client_reference_id`, and organization metadata.

Stripe documents conventional HTTP status semantics: 2xx is successful while
4xx/5xx responses represent provider/request failures. ScopeWeave therefore does
not parse a non-2xx response as a successful Checkout Session and does not reflect
provider error text to the browser.

## Compatibility boundary

Stripe documents hosted Checkout Session URLs as nullable and present only while
the Session is active. Without a configured Checkout custom domain, Stripe uses
`checkout.stripe.com`; configured custom domains use the merchant's subdomain.
The current Stripe API reference returns an example hosted Checkout URL with an
opaque fragment after the session path, so rejecting all fragments would reject
a documented provider response. ScopeWeave therefore validates the URL authority
and preserves the provider-issued URL, including its fragment, without parsing
or rewriting that fragment.

ScopeWeave does **not** silently trust arbitrary custom domains in this slice.
Supporting one requires a future operator-owned allowlist/configuration contract
and tests proving the configured authority cannot be replaced by provider or
request input.

This slice does not add durable checkout attempts, webhook verification,
subscription/payment/entitlement persistence, reconciliation, or bounded
streaming response bytes. Those remain explicit lifecycle work rather than being
silently implied by this provider-boundary slice.

## TDD and branch-reconciliation evidence

The original test-only commit `9373ac2719600d0e159b22557733a4c75def8744`
specified provider timing/authority controls before production changes. A later
parent-head review found that the parent branch dynamically imported an
undeclared `stripe` package, so a real default live request could fail with
`ERR_MODULE_NOT_FOUND` despite injected-factory tests passing.

Parent commit `ad81eb52a6f0e3448e6a17f0e500e1f140993c92` added a realistic
regression that invokes the default live path and requires a direct HTTPS Stripe
request. Parent commit `0b5e1d9a25a986546efa79d6b0a62d7b1e8395fe` implemented that
transport without adding an undeclared runtime dependency.

This stacked branch then received regression-only commit
`357ad04523f20415ca996b965943000c414c8809`, which changed the provider tests to
exercise the real default transport, non-2xx handling, invalid successful media,
malformed JSON, exact hosted-URL authority, and sanitized network failure. The
pre-repair stacked source still depended on the absent SDK and therefore could
not satisfy the default-transport contract. Commit
`9f137ef4aa5486b9b3cafe6ec1f986191bc560d0` reconciled the production provider
boundary with the parent's direct transport while preserving the stricter URL
and failure validation. Commit `bfd8718452946c514ca17009894097ce5dcf937e`
preserved the parent's default-transport regression on the child branch.

Finally, merge commit `e71d9f41893d57b69297d70c7d6a42af1763b297` records the exact
current parent `0b5e1d9...` as ancestry without force-pushing or rebasing. The
stacked comparison is therefore ahead-only from the current parent and cannot
silently discard the parent's transport repair.

The focused provider regression remains registered under the canonical c8
coverage producer; no test or deterministic gate is removed to obtain GREEN.
Hosted exact-head CI remains authoritative after every source or documentation
movement.

## Rollback

Revert the provider-boundary source change, focused tests, documentation, and
CHANGELOG entry together. No database schema or persisted billing state is
introduced, so rollback has no data migration. If billing must be disabled while
investigating a provider outage, remove the complete live provider tuple and
restart so the existing fail-closed 503 configuration path applies; do not
replace the provider error with a production mock.

## Traceability

- Issue: #488
- Parent trusted-configuration slice: PR #505
- Provider-boundary slice: PR #507
- Owned production: `server/billing.mjs`
- Parent regression: `tests/unit/billing-checkout.test.mjs`
- Provider regression: `tests/unit/billing-provider-boundary.test.mjs`
- Operator contract: `docs/billing-production.md`

## References

Stripe, Inc. (n.d.). *Authentication*. Stripe API Reference. Retrieved August 15,
2026, from https://docs.stripe.com/api/authentication

Stripe, Inc. (n.d.). *Create a Checkout Session*. Stripe API Reference. Retrieved
August 15, 2026, from https://docs.stripe.com/api/checkout/sessions/create

Stripe, Inc. (n.d.). *Errors*. Stripe API Reference. Retrieved August 15, 2026,
from https://docs.stripe.com/api/errors

Stripe, Inc. (n.d.). *The Checkout Session object*. Stripe API Reference.
Retrieved August 15, 2026, from https://docs.stripe.com/api/checkout/sessions/object
