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

> Active PR state: the provider-boundary behavior originates in stacked PR #507;
> the durable retry behavior below is active PR #511. Neither is protected-
> `develop` shipped truth until the stack is independently approved and integrated.

The live hosted-Checkout adapter performs one direct server-side HTTPS request to
Stripe for each ScopeWeave attempt:

- endpoint: exact constant `https://api.stripe.com/v1/checkout/sessions`;
- method/body: one POST with `application/x-www-form-urlencoded` fields;
- authentication: `Authorization: Bearer <STRIPE_SECRET_KEY>` sent only to the
  constant Stripe API authority;
- total request budget: 15,000 ms using an abort signal;
- redirect policy: provider HTTP redirects are rejected;
- automatic in-request retry loop: none;
- successful response budget: at most 1 MiB before UTF-8 decoding and JSON
  parsing; invalid, negative, or oversized `Content-Length` declarations are
  rejected, and a streamed body that crosses the ceiling is cancelled;
- provider/network failures: stable HTTP 502 `billing_provider_unavailable` with
  `Cache-Control: no-store`;
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
client fragment. ScopeWeave preserves provider-issued fragments verbatim after
the authority checks because fragments do not participate in HTTPS authority
selection.

Stripe Checkout custom domains are not silently trusted. Supporting one requires
a separate operator-owned allowlist or canonical-domain configuration contract
and its own regression evidence.

Provider exception text, network addresses, non-2xx response bodies, stream-read
errors, and credentials are never copied into the browser error payload. The
customer receives a retry/diagnostic next action rather than downstream internals.

The provider boundary intentionally uses the documented Stripe HTTPS API instead
of dynamically importing an undeclared runtime SDK. A clean deployment therefore
does not depend on a hidden `stripe` package merely to create the hosted Session.

## Durable Checkout attempt and idempotency boundary

> Active PR state: this section describes PR #511 only. It is not yet release or
> protected-`develop` truth.

Before the live POST, ScopeWeave persists a `billing_checkout_attempts` row with
an opaque local attempt ID, tenant/price scope, and an opaque Stripe idempotency
key. A partial unique index permits at most one `pending` attempt for the same
organization and price. The generated key is sent as the Stripe
`Idempotency-Key` header; no secret key, bearer token, or webhook secret is stored
in this ledger.

An unresolved attempt is reused only while its age is non-negative and strictly
less than 23 hours. The 23-hour local ceiling is intentionally shorter than
Stripe's documented 24-hour safe-retry horizon / at-least-24-hour key-retention
boundary. At or beyond that local ceiling, or after a local clock rollback, the
old unresolved attempt becomes `expired` before a fresh key can be created.

Provider outcomes are intentionally asymmetric:

- **network/abort/no HTTP response** — provider outcome is unknown; keep the
  attempt `pending` so the next checkout reuses the exact key;
- **Stripe 5xx** — keep the attempt `pending`; Stripe explicitly documents 500
  mutations as indeterminate and warns that retrying with a fresh key can repeat
  side effects;
- **Stripe 4xx** — close as `provider_failed`; Stripe's low-level guidance says
  the safest 4xx strategy is a fresh idempotency key when trying again;
- **validated 2xx Checkout Session** — validate provider session ID and hosted
  destination, persist `provider_succeeded` plus the provider session ID, then
  return the hosted URL;
- **2xx with malformed, over-budget, or untrusted content** — close as
  `provider_failed` and return only the stable sanitized error contract;
- **provider success followed by local persistence failure** — return
  `billing_checkout_state_unavailable` and leave the attempt pending. A later
  checkout can replay the same key instead of creating a second provider object.

Repository construction and request handling perform no DDL. The schema is
installed during database bootstrap after the organization table exists. That
matches the repository's current migration style, but billing release approval
remains blocked until this schema is reconciled with the formal migration-ledger,
restore, and rollback work elsewhere in the repository.

`docs/doctoring/stripe-checkout-attempt-idempotency.md` records the evidence,
TDD chronology, data model, threat/rollback reasoning, and APA 7 references.

## Current lifecycle boundary

The trusted-configuration, provider-trust, and durable-attempt slices do **not**
declare the Stripe subscription lifecycle production complete. Before production
billing can be release-approved, ScopeWeave still needs the remaining #488
controls, including raw-body webhook signature verification and streaming size
limits; durable event deduplication; out-of-order reconciliation; normalized
customer/subscription/payment/entitlement state; transactional reversible
entitlement changes; migration and restore evidence; retention/privacy/incident
runbooks; and provider smoke plus release acceptance.

No custom Checkout domain should be accepted before an operator-owned trust
configuration exists. No unresolved attempt record should be deleted merely to
force a retry with a fresh provider key.

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
5. Confirm the outbound request contains an opaque `Idempotency-Key`, then force a
   transport timeout and retry the same organization/price inside the local
   safety window. The second request must reuse the same key and local attempt ID.
6. Exercise HTTP 400 and HTTP 503 responses separately. A 400 must close the
   attempt so a later deliberate checkout receives a fresh key; a 503 must leave
   the attempt pending so a later retry cannot silently duplicate provider side
   effects.
7. Exercise non-JSON success, malformed JSON, bodyless success,
   invalid/oversized declared response length, streamed response overflow,
   stream-read failure, and provider timeout handling. Confirm response bodies
   above 1 MiB are not buffered/parsed and callers receive only the stable
   no-store error contract without provider body, network, stream, or credential
   detail.
8. Reject null, malformed, plaintext, credential-bearing, non-standard-port,
   and hostname-confusion Checkout destinations; accept and preserve the exact
   standard `https://checkout.stripe.com/...#...` hosted destination, including
   its provider-issued fragment.
9. Simulate a successful Stripe response followed by a local state-write failure.
   The customer must receive `billing_checkout_state_unavailable`, and a later
   retry must preserve the original idempotency identity rather than minting a
   duplicate Checkout Session.
10. Keep the rollout blocked until the remaining #488 lifecycle controls and the
    formal migration/restore path are implemented and their exact-head security,
    coverage, review, rollback, and recovery gates pass together.

Rollback is no longer data-neutral once PR #511 exists. Disable the complete live
Stripe configuration and restart before reverting request-path code. Preserve
`pending` and `provider_succeeded` attempt rows for reconciliation. Do not drop
or truncate the ledger during a provider incident; any eventual schema removal
must be a reviewed reversible migration with export/restore evidence.