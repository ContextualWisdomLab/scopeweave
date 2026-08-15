# Stripe Checkout provider trust boundary

Status: **active stacked PR design/implementation evidence; not protected-`develop`
shipped truth until its parent and this slice are independently approved and
integrated.**

## Buyer-visible failure being closed

The trusted-origin billing slice prevents request authority from controlling
success/cancel redirects, but a provider boundary also has to constrain how long
Checkout can block a request, how retries can duplicate a side effect, what
provider-returned URL the browser may follow, and what failure detail can leave
the server.

Without those controls a buyer cannot distinguish a controlled billing outage
from an indefinite provider wait, and a compromised or malformed provider
response could become redirect authority.

## Decision

For hosted Stripe Checkout, this slice applies four narrow controls:

1. Stripe client construction and `checkout.sessions.create` receive a 15,000 ms
   timeout.
2. Automatic network retries are set to zero until ScopeWeave has durable
   checkout-attempt identifiers and idempotency state. A later lifecycle slice
   may introduce retries only together with that durable reconciliation model.
3. The returned Checkout Session `url` is parsed with the platform `URL` parser
   and accepted only when it uses HTTPS, has exact hostname
   `checkout.stripe.com`, uses the default HTTPS port, and contains no URL
   credentials or fragment.
4. Provider transport/import failures and invalid provider responses become
   stable, `Cache-Control: no-store` HTTP 502 responses. Internal network text,
   provider exception detail, and credentials are not reflected to callers.

The validation uses exact parsed authority fields rather than string-prefix or
suffix matching, so `checkout.stripe.com.evil.example` is not trusted.

## Compatibility boundary

Stripe documents hosted Checkout Session URLs as nullable and present only while
the Session is active. Without a configured Checkout custom domain, Stripe uses
`checkout.stripe.com`; configured custom domains use the merchant's subdomain.
ScopeWeave does **not** silently trust arbitrary custom domains in this slice.
Supporting one requires a future operator-owned allowlist/configuration contract
and tests proving the configured authority cannot be replaced by provider or
request input.

This slice does not add durable checkout attempts, webhook verification,
subscription/payment/entitlement persistence, or reconciliation. It also does
not by itself make the live SDK installable on a clean deployment; the official
Stripe package/lockfile remains a separate packaging gate unless incorporated by
an exact lockfile change before this PR leaves Draft.

## TDD evidence

Test-only commit `9373ac2719600d0e159b22557733a4c75def8744` added the provider
contract before production changes. Reproducing that exact parent billing source
under Node.js 22.16.0 failed as expected because `checkout.sessions.create`
received no request options: expected `{ maxNetworkRetries: 0, timeout: 15000 }`,
actual `undefined`.

The same regression suite also specifies invalid destination rejection and
sanitized provider failures. Those tests remain under the canonical c8 coverage
producer; no test or gate is removed to obtain GREEN.

## Rollback

Revert the provider-boundary source change, its focused tests, documentation,
and CHANGELOG entry together. No database schema or persisted billing state is
introduced, so rollback has no data migration. If billing must be disabled while
investigating a provider outage, remove the complete live provider tuple and
restart so the existing fail-closed 503 configuration path applies; do not
replace the provider error with a production mock.

## Traceability

- Issue: #488
- Parent trusted-configuration slice: PR #505
- Provider-boundary slice: PR #507
- Owned production: `server/billing.mjs`
- Regression: `tests/unit/billing-provider-boundary.test.mjs`
- Operator contract: `docs/billing-production.md`

## References

Stripe, Inc. (2026, July 29). *stripe-node v22.4.0* [Computer software]. GitHub.
https://github.com/stripe/stripe-node/releases/tag/v22.4.0

Stripe, Inc. (n.d.). *Stripe Node.js library*. GitHub. Retrieved August 15, 2026,
from https://github.com/stripe/stripe-node

Stripe, Inc. (n.d.). *The Checkout Session object*. Stripe API Reference.
Retrieved August 15, 2026, from https://docs.stripe.com/api/checkout/sessions/object
