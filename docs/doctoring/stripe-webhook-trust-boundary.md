# Stripe webhook trust boundary

## Decision

Protected `develop` previously accepted an unauthenticated
`checkout.session.completed` JSON body and upgraded `orgs.plan` to `pro`. That
is a privilege-escalation window: any caller who can POST to
`/api/stripe/webhook` can grant paid entitlements.

The integrated HTTP composition has one ordered security envelope:

1. `server/app.mjs` owns the public transport-peer-aware rate limiter and wraps
   the route graph before any route-specific identity or database work;
2. `server/app_routes.mjs` is a transitional import seam that delegates to the
   supported shared boundary in `server/application_routes.mjs` while the public
   envelope initializes the historical core limiter disabled;
3. the shared boundary installs production OIDC fail-closed, invite identity
   binding, and pending-invite-token redaction guards before mounting the
   internal implementation graph from `server/application_routes_core.mjs`;
4. the internal graph retains request logging and metrics and contains the
   single `POST /api/stripe/webhook` route; and
5. that route HMAC-SHA-256-checks the exact bounded raw body using the Stripe
   `t` and `v1` signature values before parsing JSON, acknowledges an authentic
   delivery with `{ received: true }`, and does **not** mutate `orgs.plan`.

The public limiter is authoritative for public traffic, so rejected OIDC/invite
requests cannot perform route-guard database lookups before rate-limit admission.
The shared boundary still delegates guard rejections through a non-mutating core
accounting probe so request logging and metrics retain the attempted operation.
Direct consumers of `application_routes.mjs` retain the core limiter according
to their own initialization environment; the compatibility `app_routes.mjs`
seam is not a supported consumer entry point.

`server/application_routes_core.mjs` is an internal implementation module, not
a supported application entry point. Consumers must import
`server/application_routes.mjs` or `server/app.mjs`; bypassing the supported
boundary would bypass its OIDC and invitation controls.

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
endpoint remains inside the ordered abuse-control and observability composition
so unsigned floods are rate-limited before route-specific work and remain
visible in request accounting.

## Verification contract

Regression tests must prove:

- unsigned `checkout.session.completed` JSON never upgrades `orgs.plan`;
- a correctly signed delivery is acknowledged and still leaves plan unchanged;
- a stale timestamp or a JSON-equivalent mutated body fails signature checks;
- when `SCOPEWEAVE_RATE_LIMIT_MAX=1`, the second webhook in the window is `429`;
- `server/app.mjs` establishes the public limiter before mounting the supported
  shared route graph;
- the transitional import seam delegates only to `application_routes.mjs`;
- the shared boundary installs OIDC and invitation guards before
  `app.route('/', coreRoutes)`;
- both the public app and the supported shared route graph fail closed when
  production OIDC is unconfigured;
- the internal core Stripe route invokes `verifyStripeWebhookRequest`; and
- the core graph contains no `checkout.session.completed` path that treats
  callback JSON as entitlement authority.

## Officer next action

Rotate `STRIPE_WEBHOOK_SECRET` if it may have been exposed while the unsigned
stub was live. Point the Stripe endpoint at the public `/api/stripe/webhook`
path. Configure `SCOPEWEAVE_TRUSTED_PROXY_IPS` only for authenticated/controlled
reverse-proxy peers; otherwise forwarding headers are intentionally ignored. Do
not treat a `200 { received: true }` as proof that the organization is Pro until
reconciliation writes entitlements from Stripe's retrieved session state.

## References

Krawczyk, H., Bellare, M., & Canetti, R. (1997). *HMAC: Keyed-hashing for
message authentication* (RFC 2104). Internet Engineering Task Force.
https://doi.org/10.17487/RFC2104

National Institute of Standards and Technology. (2008). *The keyed-hash
message authentication code (HMAC)* (FIPS PUB 198-1). U.S. Department of
Commerce. https://doi.org/10.6028/NIST.FIPS.198-1

Stripe. (n.d.). *Webhook signatures*. Stripe Docs.
https://docs.stripe.com/webhooks/signatures
