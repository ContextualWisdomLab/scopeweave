# Stripe checkout trusted-origin evidence

## Decision

ScopeWeave separates request authority from billing redirect authority. Checkout
success/cancel URLs derive only from the operator-owned
`SCOPEWEAVE_PUBLIC_ORIGIN`; an inbound request URL, `Host`, or forwarded host is
not a trusted redirect source.

A Stripe-enabled process must also receive `STRIPE_SECRET_KEY`,
`STRIPE_PRICE_ID`, and `STRIPE_WEBHOOK_SECRET` as one complete startup tuple.
Partial provider configuration fails startup. A complete tuple without the
public origin fails startup. Without the tuple, production billing remains
disabled; only explicit `SCOPEWEAVE_DEV=1` plus a valid public loopback origin
may select the mock checkout path.

The configured public origin is parsed with the WHATWG `URL` API and is accepted
only as a root HTTPS origin. Credentials, a configured path, query, fragment,
unsupported scheme, and remote plaintext HTTP are rejected. Development HTTP is
limited to `localhost`, `127.0.0.1`, and WHATWG-serialized IPv6 loopback `[::1]`.

## Threat and standards rationale

Stripe Checkout sessions are created server-side and carry success/cancel URLs.
Using request authority to populate those URLs would let reverse-proxy or
host-header misconfiguration influence a security-sensitive customer redirect.
The operator origin is therefore explicit configuration rather than request
derived data.

The WHATWG URL Standard defines the parsed URL components and tuple origin used
by the JavaScript `URL` implementation. Parsing first and then applying
component-level policy avoids ambiguous prefix/string matching.

Stripe documents idempotency keys for safely retrying POST requests and webhook
handling requirements including raw-body signature verification, duplicate
events, and non-guaranteed event ordering. Those requirements are intentionally
recorded here as the next lifecycle boundary; this slice does not claim to have
implemented them.

## Executable evidence

`tests/unit/billing-configuration.test.mjs` proves:

- no provider tuple in production resolves to a disabled capability, not a mock;
- explicit development mode plus loopback origin enables only the mock;
- partial Stripe tuples fail closed;
- a live tuple requires a canonical public origin;
- credentials, path, query, fragment, malformed URLs, unsupported schemes, and
  remote HTTP are rejected; and
- development loopback HTTP and canonical HTTPS serialization behave exactly as
  documented.

`tests/unit/billing-checkout.test.mjs` proves:

- disabled production checkout raises an actionable HTTP 503 response;
- a caller-supplied/request-derived `origin` property is ignored by the checkout
  implementation;
- mock organization identifiers are percent encoded; and
- an injected deterministic Stripe client receives success/cancel URLs built
  from the configured public origin rather than a request host.

`tests/api/billing-checkout.test.mjs` drives the real Hono route with requests
addressed to `https://attacker.example` while the operator origin is
`http://127.0.0.1:8787`; the returned mock Checkout URL remains bound to the
operator origin. The package coverage producer includes both billing production
modules and these regressions.

## Scope limit and remaining acquisition gap

This is the first bounded vertical slice of issue #488 and **does not close it**.
It introduces no billing database schema and makes no claim that subscription
entitlements are production complete. The following remain blocking work:

- durable checkout-attempt UUIDs and stable Stripe idempotency keys;
- a packaged/pinned Stripe SDK plus bounded provider connect/total time,
  redirects, response bytes, and JSON parsing;
- validation of returned hosted Checkout destinations;
- exact raw-body webhook signature verification with bounded timestamp
  tolerance and body size;
- durable event-ID deduplication and non-sensitive audit metadata;
- out-of-order event reconciliation against authoritative provider state or a
  monotonic per-object cursor;
- 3NF customer/subscription/payment/organization-entitlement state machines;
- transactional, reversible entitlement transitions; and
- migration, incident, recovery, privacy, test-mode provider smoke, and release
  acceptance evidence.

## Rollback

Rollback reverts `server/billing_configuration.mjs`, the checkout authority
change in `server/billing.mjs`, the registered unit/API coverage cases, billing
operations documentation, and this evidence record together. No database
migration or persisted billing record is introduced by this slice.

## References

Stripe. (n.d.). *Create a Checkout Session*. Stripe API Reference.
https://docs.stripe.com/api/checkout/sessions/create

Stripe. (n.d.). *Idempotent requests*. Stripe API Reference.
https://docs.stripe.com/api/idempotent_requests

Stripe. (n.d.). *Receive Stripe events in your webhook endpoint*. Stripe
Documentation. https://docs.stripe.com/webhooks

WHATWG. (2026). *URL Standard*. https://url.spec.whatwg.org/
