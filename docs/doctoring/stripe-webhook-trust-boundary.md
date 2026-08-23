# Stripe webhook trust boundary

## Decision

Protected `develop` previously accepted an unauthenticated
`checkout.session.completed` JSON body and upgraded `orgs.plan` to `pro`. That
is a privilege-escalation window: any caller who can POST to
`/api/stripe/webhook` can grant paid entitlements.

The public application now:

1. copies the protected route graph, including logging and rate-limit
   middleware, except the historical Stripe handler;
2. registers a fail-closed verifier that HMAC-SHA-256-checks
   `timestamp + "." + raw body` against `STRIPE_WEBHOOK_SECRET` before parsing
   JSON;
3. acknowledges an authentic delivery with `{ received: true }` and does **not**
   mutate `orgs.plan`; and
4. keeps the protected-graph copy of the same route fail-closed so a future
   composer that mounts `application_routes` directly cannot restore unsigned
   plan upgrades.

Signature validity authenticates the delivery only. Durable event
deduplication, provider-state reconciliation, and entitlement writes remain
follow-up work (stacked billing lifecycle), not this hotfix.

## Standards rationale

HMAC-SHA-256 over the exact signed bytes is the Stripe webhook contract and
matches RFC 2104 / FIPS 198-1 keyed hashing. JSON parsing happens only after
constant-time comparison so semantically equivalent but byte-different bodies
cannot be substituted. Replay is bounded by a five-minute timestamp window.
Missing configuration fails closed with `503 stripe_webhook_not_configured`
rather than accepting unsigned traffic.

OAuth bearer-token rules (RFC 6750; RFC 9700) do not apply to this provider
callback; the webhook secret is a shared HMAC key, not an access token. The
endpoint remains behind the same abuse-control middleware as the rest of the
application so unsigned floods are rate-limited instead of skipping the limiter
through a first-match public route.

## Verification contract

Regression tests must prove:

- unsigned `checkout.session.completed` JSON never upgrades `orgs.plan`;
- a correctly signed delivery is acknowledged and still leaves plan unchanged;
- a stale timestamp or a JSON-equivalent mutated body fails signature checks;
- when `SCOPEWEAVE_RATE_LIMIT_MAX=1`, the second webhook in the window is `429`;
- the public app does not `app.route('/', applicationRoutes)`;
- the public app copies protected routes except `POST /api/stripe/webhook` and
  then registers `verifyStripeWebhookRequest`; and
- `application_routes.mjs` no longer contains a `checkout.session.completed`
  plan-upgrade path.

## Officer next action

Rotate `STRIPE_WEBHOOK_SECRET` if it may have been exposed while the unsigned
stub was live. Point the Stripe endpoint at the public `/api/stripe/webhook`
path. Do not treat a `200 { received: true }` as proof that the organization is
Pro until reconciliation writes entitlements from Stripe's retrieved session
state.

## References

Krawczyk, H., Bellare, M., & Canetti, R. (1997). *HMAC: Keyed-hashing for
message authentication* (RFC 2104). Internet Engineering Task Force.
https://doi.org/10.17487/RFC2104

National Institute of Standards and Technology. (2008). *The keyed-hash
message authentication code (HMAC)* (FIPS PUB 198-1). U.S. Department of
Commerce. https://doi.org/10.6028/NIST.FIPS.198-1

Stripe. (n.d.). *Webhook signatures*. Stripe Docs.
https://docs.stripe.com/webhooks/signatures
