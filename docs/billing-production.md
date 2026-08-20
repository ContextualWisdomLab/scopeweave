# Billing production configuration

ScopeWeave treats billing as a separately deployable capability. An absent Stripe
configuration does **not** imply a successful production checkout. The only
successful mock path is explicit development mode.

## Configuration contract

A live checkout process requires all of the following values together:

- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID`
- `STRIPE_WEBHOOK_SECRET`
- `SCOPEWEAVE_PUBLIC_ORIGIN`

The three Stripe values are an all-or-none startup tuple. A partial tuple stops
application startup with `billing_configuration_incomplete`. A complete Stripe
tuple without `SCOPEWEAVE_PUBLIC_ORIGIN` stops startup with
`billing_public_origin_required`.

`SCOPEWEAVE_PUBLIC_ORIGIN` is the operator-owned browser origin used to construct
Checkout success and cancellation URLs. ScopeWeave parses it with the platform
`URL` implementation and accepts a root HTTPS origin only. URL credentials,
paths, query strings, fragments, unsupported schemes, and remote plaintext HTTP
are rejected. Explicit `SCOPEWEAVE_DEV=1` may use HTTP only on `localhost`,
`127.0.0.1`, or `::1`.

Example production shape:

```text
SCOPEWEAVE_PUBLIC_ORIGIN=https://planner.example.com
STRIPE_SECRET_KEY=<secret-manager reference>
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=<secret-manager reference>
```

Do not derive `SCOPEWEAVE_PUBLIC_ORIGIN` from `Host`, `Forwarded`,
`X-Forwarded-Host`, or the incoming request URL. Proxy headers describe a request
path through infrastructure; they are not billing redirect authority.

## Disabled and development behavior

With no Stripe tuple, production billing is disabled. A checkout attempt fails
closed with HTTP 503 and `billing_not_configured` rather than generating a fake
success URL. The response tells the operator to configure the complete Stripe
settings and public origin, then restart ScopeWeave.

For local integration tests, `SCOPEWEAVE_DEV=1` plus a valid loopback
`SCOPEWEAVE_PUBLIC_ORIGIN` enables the mock checkout. The mock URL is built from
the configured origin and a percent-encoded organization identifier; a different
request host cannot replace that origin.

## Current slice boundary

This document describes only the trusted-configuration and redirect-authority
slice of issue #488. It does **not** declare the Stripe lifecycle production
complete. Before production billing can be release-approved, ScopeWeave still
needs the remaining #488 controls, including durable checkout attempts and stable
idempotency keys, a packaged/pinned provider SDK and bounded provider transport,
validated returned Checkout destinations, raw-body webhook verification and
size limits, durable event deduplication, out-of-order reconciliation, normalized
subscription/payment/entitlement state, rollback/recovery procedures, and
end-to-end operational acceptance evidence.

## Operator verification

Before a billing-enabled rollout:

1. Start a canary with the complete Stripe tuple and the exact public browser
   origin intended for customer redirects.
2. Confirm malformed, partial, path-bearing, query-bearing, credential-bearing,
   and plaintext remote origins stop startup.
3. Send a checkout request through the same reverse proxy used in production
   while varying the request authority; success/cancel URLs must still use only
   `SCOPEWEAVE_PUBLIC_ORIGIN`.
4. Keep the rollout blocked until the remaining #488 lifecycle controls are
   implemented and their exact-head security, coverage, review, rollback, and
   recovery gates pass together.

Rollback for this slice is configuration-neutral: revert the validation module,
checkout authority change, and tests together. No database migration or
persisted billing state is introduced here.
