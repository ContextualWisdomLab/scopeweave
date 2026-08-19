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

The default live Checkout transport uses the platform HTTPS `fetch` boundary,
not an undeclared Stripe runtime SDK. A provider response is accepted only when
HTTP reports success, JSON parsing succeeds, and the resulting hosted Checkout
Session contains a non-empty HTTPS URL without URL credentials. Network errors,
timeouts, non-2xx provider responses, malformed JSON, missing URLs, plaintext
URLs, and credential-bearing URLs fail closed as a stable HTTP 502 response.
Provider response bodies and transport details are never copied into that
customer-facing failure payload.

## Threat and standards rationale

Stripe Checkout sessions are created server-side and carry success/cancel URLs.
Using request authority to populate those URLs would let reverse-proxy or
host-header misconfiguration influence a security-sensitive customer redirect.
The operator origin is therefore explicit configuration rather than request
derived data.

Stripe's API error contract uses conventional HTTP status classes: successful
requests are represented by 2xx responses, while 4xx and 5xx responses represent
request/provider failures. Treating an error document as a successful Checkout
Session can return an undefined or otherwise unusable redirect to the buyer, so
the direct transport validates HTTP success before parsing the session. Stripe's
Checkout Session API returns a Checkout Session object after successful
creation; ScopeWeave additionally validates the returned hosted URL before
exposing it to the caller.

The WHATWG URL Standard defines the parsed URL components and tuple origin used
by the JavaScript `URL` implementation. Parsing first and then applying
component-level policy avoids ambiguous prefix/string matching.

Stripe documents idempotency keys for safely retrying POST requests and webhook
handling requirements including raw-body signature verification, duplicate
events, and non-guaranteed event ordering. Those requirements are intentionally
recorded here as the next lifecycle boundary; this root slice does not claim to
have implemented them.

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
- mock organization identifiers are percent encoded;
- an injected deterministic Stripe client receives success/cancel URLs built
  from the configured public origin rather than a request host;
- the default provider path posts only to Stripe's HTTPS Checkout Sessions API;
- provider non-2xx responses and network failures collapse to a non-leaking HTTP
  502 failure envelope;
- malformed success JSON and missing hosted URLs are rejected;
- plaintext, malformed, or URL-credential-bearing provider redirects are
  rejected; and
- unexpected injected-provider failures use the same safe failure envelope.

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
- bounded provider response-size enforcement and retry policy that distinguishes
  safe transient failure from permanent configuration/request failure;
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

Rollback reverts `server/billing_configuration.mjs`, the checkout authority and
provider-response validation in `server/billing.mjs`, the registered unit/API
coverage cases, billing operations documentation, and this evidence record
together. No database migration or persisted billing record is introduced by
this slice.

## References

Stripe. (n.d.). *Create a Checkout Session*. Stripe API Reference.
https://docs.stripe.com/api/checkout/sessions/create

Stripe. (n.d.). *Errors*. Stripe API Reference.
https://docs.stripe.com/api/errors

Stripe. (n.d.). *Error handling*. Stripe Documentation.
https://docs.stripe.com/error-handling

Stripe. (n.d.). *Idempotent requests*. Stripe API Reference.
https://docs.stripe.com/api/idempotent_requests

Stripe. (n.d.). *Receive Stripe events in your webhook endpoint*. Stripe
Documentation. https://docs.stripe.com/webhooks

WHATWG. (2026). *URL Standard*. https://url.spec.whatwg.org/
