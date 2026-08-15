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

## Provider trust boundary

> Active PR state: this section describes the stacked provider-boundary work in
> PR #507. It is not protected-`develop` shipped truth until its parent PR #505
> and this PR are independently approved and integrated.

The live hosted-Checkout adapter performs one direct server-side HTTPS request to
Stripe until a later lifecycle slice introduces durable checkout-attempt and
idempotency state:

- endpoint: exact constant `https://api.stripe.com/v1/checkout/sessions`;
- method/body: one POST with `application/x-www-form-urlencoded` fields;
- authentication: `Authorization: Bearer <STRIPE_SECRET_KEY>` sent only to the
  constant Stripe API authority;
- total request budget: 15,000 ms using an abort signal;
- redirect policy: provider HTTP redirects are rejected;
- automatic application retries: none;
- successful response budget: at most 1 MiB before UTF-8 decoding and JSON
  parsing; invalid, negative, or oversized `Content-Length` declarations are
  rejected, and a streamed body that crosses the ceiling is cancelled;
- network, abort, or non-2xx provider failures: stable HTTP 502
  `billing_provider_unavailable` with `Cache-Control: no-store`;
- successful non-JSON, bodyless, unreadable, malformed JSON, or oversized
  responses: stable HTTP 502 `billing_provider_invalid_response` with
  `Cache-Control: no-store`;
- malformed or untrusted Checkout destinations: stable HTTP 502
  `billing_provider_invalid_response` with `Cache-Control: no-store`;
- browser destination: parsed with `URL` and accepted only for HTTPS, exact
  hostname `checkout.stripe.com`, default HTTPS port, and no URL credentials.

This exact-host check deliberately rejects suffix-confusion names such as
`checkout.stripe.com.evil.example`. Stripe's current Checkout Session API
reference shows a standard hosted `checkout.stripe.com` URL containing an opaque
`#fidk...` fragment. ScopeWeave therefore preserves provider-issued fragments
verbatim after the authority checks instead of treating a fragment as an origin
or hostname decision.

Stripe Checkout custom domains are not silently trusted. Supporting one requires
a separate operator-owned allowlist or canonical-domain configuration contract
and its own regression evidence.

Provider exception text, network addresses, non-2xx response bodies, stream-read
errors, and credentials are never copied into the browser error payload. The
customer receives a retry/diagnostic next action rather than downstream internals.

The provider boundary intentionally uses the documented Stripe HTTPS API instead
of dynamically importing an undeclared runtime SDK. A clean deployment therefore
does not depend on a hidden `stripe` package merely to create the hosted Session.
Package provenance remains part of the normal application supply-chain gate, but
there is no Stripe SDK package gate for this direct adapter.

## Current lifecycle boundary

The trusted-configuration and provider-trust slices do **not** declare the Stripe
subscription lifecycle production complete. Before production billing can be
release-approved, ScopeWeave still needs the remaining #488 controls, including:

a durable checkout-attempt UUID and stable idempotency key; raw-body webhook
signature verification and streaming size limits; durable event deduplication;
out-of-order reconciliation; normalized customer/subscription/payment/entitlement
state; transactional reversible entitlement changes; migration and restore
evidence; privacy/incident runbooks; and provider smoke plus release acceptance.

No automatic provider retry should be enabled before durable idempotency exists.
No custom Checkout domain should be accepted before an operator-owned trust
configuration exists.

## Operator verification

Before a billing-enabled rollout:

1. Start a canary with the complete Stripe tuple and the exact public browser
   origin intended for customer redirects.
2. Confirm malformed, partial, path-bearing, query-bearing, credential-bearing,
   and plaintext remote origins stop startup.
3. Send a checkout request through the same reverse proxy used in production
   while varying the request authority; success/cancel URLs must still use only
   `SCOPEWEAVE_PUBLIC_ORIGIN`.
4. Capture the canary's outbound request destination and verify exactly one POST
   goes to `api.stripe.com/v1/checkout/sessions`, redirects are not followed, and
   the request aborts within the configured 15-second total budget.
5. Exercise network failure, non-2xx response, non-JSON success, malformed JSON,
   bodyless success, invalid/oversized declared response length, streamed
   response overflow, stream-read failure, and provider timeout handling.
   Confirm response bodies above 1 MiB are not buffered/parsed and callers
   receive only the stable no-store 502 contract without provider body, network,
   stream, or credential detail.
6. Reject null, malformed, plaintext, credential-bearing, non-standard-port,
   and hostname-confusion Checkout destinations; accept and preserve the exact
   standard `https://checkout.stripe.com/...#...` hosted destination, including
   its provider-issued fragment.
7. Keep the rollout blocked until the remaining #488 lifecycle controls are
   implemented and their exact-head security, coverage, review, rollback, and
   recovery gates pass together.

Rollback for the trusted-configuration/provider-boundary stack is data-neutral:
revert the validation and provider-boundary source, tests, documentation, and
CHANGELOG entries together. No database migration or persisted billing state is
introduced by these slices. If billing must be disabled while investigating a
provider outage, remove the complete live provider tuple and restart; never
substitute a production mock.
